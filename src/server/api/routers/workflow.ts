import { Effect } from "effect";
import { z } from "zod";

import { ServerRuntime } from "~/effect/server/runtime";
import {
  deserializeStoredWorkflowDocument,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import type { StartWorkflowExecutionRequest } from "~/lib/workflow/execution/types";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_MODEL_IDS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_MODEL_IDS,
  VIDEO_RESOLUTIONS,
} from "~/lib/workflow/types";
import { toTRPCError } from "~/server/api/errors";
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";
import { WorkflowCreditsService } from "~/server/workflow/credits";
import { WorkflowExecutionService } from "~/server/workflow/execution-service";
import { WorkflowStorage } from "~/server/workflow/storage";
import { VertexAi } from "~/server/workflow/vertex";

const workflowAssetSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "video"]),
  source: z.enum(["upload", "generated"]),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  createdAt: z.string(),
  url: z.string(),
  storagePath: z.string().nullable(),
  externalUri: z.string().nullable(),
  model: z.string().nullable(),
});

const formDataSchema = z.custom<FormData>(
  (value) => value instanceof FormData,
  "Expected FormData input.",
);

const videoDurationSchema = z.custom<(typeof VIDEO_DURATIONS)[number]>(
  (value) =>
    typeof value === "number" &&
    VIDEO_DURATIONS.includes(value as (typeof VIDEO_DURATIONS)[number]),
  "Invalid video duration.",
);

const workflowDocumentSchema = z
  .custom<WorkflowDocument>(
    (value) => Boolean(deserializeStoredWorkflowDocument(value)),
    "Invalid workflow document.",
  )
  .transform(
    (value) =>
      deserializeStoredWorkflowDocument(value) as NonNullable<
        ReturnType<typeof deserializeStoredWorkflowDocument>
      >,
  );

const workflowExecutionTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("selected-or-all"),
  }),
  z.object({
    type: z.literal("node"),
    nodeId: z.string(),
  }),
]);

const workflowExecutionRequestSchema = z.object({
  document: workflowDocumentSchema,
  target: workflowExecutionTargetSchema,
  clientRunId: z.string().nullable().optional(),
  documentVersion: z.number().nullable().optional(),
  idempotencyKey: z.string().nullable().optional(),
  selection: z
    .object({
      nodeIds: z.array(z.string()),
    })
    .nullable()
    .optional(),
});

export const workflowRouter = createTRPCRouter({
  startExecution: protectedProcedure
    .input(workflowExecutionRequestSchema)
    .mutation(async ({ ctx, input }) => {
      const request = input as StartWorkflowExecutionRequest;
      const userId = ctx.session.user.id;

      return ServerRuntime.runPromise(
        Effect.gen(function* () {
          const workflowExecutionService = yield* WorkflowExecutionService;
          const run = yield* workflowExecutionService.createRun(
            userId,
            request,
          );

          void ServerRuntime.runPromise(
            Effect.gen(function* () {
              const backgroundWorkflowExecutionService =
                yield* WorkflowExecutionService;
              yield* backgroundWorkflowExecutionService.executeRun(
                run.runId,
                userId,
                request,
              );
            }),
          ).catch((error) => {
            console.error("Workflow execution failed", error);
          });

          return run;
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      });
    }),

  getCredits: protectedProcedure.query(async ({ ctx }) =>
    ServerRuntime.runPromise(
      Effect.gen(function* () {
        const workflowCreditsService = yield* WorkflowCreditsService;
        return yield* workflowCreditsService.getBalanceSummary(
          ctx.session.user.id,
        );
      }),
    ).catch((error) => {
      throw toTRPCError(error);
    }),
  ),

  generateImage: publicProcedure
    .input(
      z.object({
        model: z.enum(IMAGE_MODEL_IDS),
        mode: z.string().nullable(),
        prompt: z.string(),
        referenceImages: z.array(workflowAssetSchema).optional(),
        aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).optional(),
      }),
    )
    .mutation(async ({ input }) =>
      ServerRuntime.runPromise(
        Effect.gen(function* () {
          const vertexAi = yield* VertexAi;
          return yield* vertexAi.generateImagesWithNanoBananaPro(input);
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      }),
    ),

  generateVideo: publicProcedure
    .input(
      z.object({
        model: z.enum(VIDEO_MODEL_IDS),
        mode: z.string().nullable(),
        prompt: z.string(),
        referenceImages: z.array(workflowAssetSchema).optional(),
        aspectRatio: z.enum(VIDEO_ASPECT_RATIOS).optional(),
        durationSeconds: videoDurationSchema.optional(),
        generateAudio: z.boolean().optional(),
        resolution: z.enum(VIDEO_RESOLUTIONS).optional(),
      }),
    )
    .mutation(async ({ input }) =>
      ServerRuntime.runPromise(
        Effect.gen(function* () {
          const vertexAi = yield* VertexAi;
          return yield* vertexAi.generateVideosWithVeo31(input);
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      }),
    ),

  uploadAsset: publicProcedure
    .input(formDataSchema)
    .mutation(async ({ input }) =>
      ServerRuntime.runPromise(
        Effect.gen(function* () {
          const workflowStorage = yield* WorkflowStorage;
          const file = input.get("file");

          if (!(file instanceof File)) {
            return yield* Effect.fail(
              new WorkflowValidationError({ message: "Missing file upload." }),
            );
          }

          const kind = file.type.startsWith("image/")
            ? "image"
            : file.type.startsWith("video/")
              ? "video"
              : null;

          if (!kind) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Only image and video uploads are supported.",
              }),
            );
          }

          const asset = yield* workflowStorage.saveFormFileAsAsset({
            file,
            kind,
            source: "upload",
          });

          return { asset };
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      }),
    ),
});
