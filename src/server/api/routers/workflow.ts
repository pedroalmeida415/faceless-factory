import { Effect } from "effect";
import { z } from "zod";

import { ServerRuntime } from "~/effect/server/runtime";
import {
  deserializeStoredWorkflowDocument,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import type {
  StartWorkflowExecutionRequest,
  WorkflowExecutionStatusResponse,
} from "~/lib/workflow/execution/types";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_MODEL_IDS,
  LLM_MODEL_IDS,
  LLM_THINKING_LEVELS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_MODEL_IDS,
  VIDEO_RESOLUTIONS,
} from "~/lib/workflow/types";
import { toTRPCError } from "~/server/api/errors";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { WorkflowCreditsService } from "~/server/workflow/credits";
import { WorkflowExecutionService } from "~/server/workflow/execution-service";
import { quoteWorkflowExecution } from "~/server/workflow/pricing";
import { saveWorkflowProjectDocument } from "~/server/workflow/projects";
import { WorkflowRunStore } from "~/server/workflow/run-store";
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
  projectId: z.string(),
  target: workflowExecutionTargetSchema,
  clientRunId: z.string().nullable().optional(),
  documentRevision: z.number().nullable().optional(),
  idempotencyKey: z.string().nullable().optional(),
  selection: z
    .object({
      nodeIds: z.array(z.string()),
    })
    .nullable()
    .optional(),
});

const workflowExecutionEventsSchema = z.object({
  lastEventId: z.string().nullish(),
  runId: z.string(),
});

const saveWorkflowProjectSchema = z.object({
  document: workflowDocumentSchema,
  documentRevision: z.number().int().nonnegative(),
  projectId: z.string(),
});

function isTerminalStatus(status: "queued" | "running" | "success" | "error") {
  return status === "success" || status === "error";
}

export const workflowRouter = createTRPCRouter({
  listAssets: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .output(z.array(workflowAssetSchema))
    .query(async ({ ctx, input }) =>
      ServerRuntime.runPromise(
        Effect.gen(function* () {
          const workflowStorage = yield* WorkflowStorage;
          return yield* workflowStorage.listProjectAssets({
            ownerUserId: ctx.session.user.id,
            projectId: input.projectId,
          });
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      }),
    ),

  saveProject: protectedProcedure
    .input(saveWorkflowProjectSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const lockedNodeIds = await ServerRuntime.runPromise(
          Effect.gen(function* () {
            const workflowRunStore = yield* WorkflowRunStore;
            return yield* workflowRunStore.getProjectLockedNodeIds({
              projectId: input.projectId,
              userId: ctx.session.user.id,
            });
          }),
        );

        return await saveWorkflowProjectDocument({
          document: input.document,
          documentRevision: input.documentRevision,
          lockedNodeIds,
          ownerUserId: ctx.session.user.id,
          projectId: input.projectId,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  quoteExecution: protectedProcedure
    .input(workflowExecutionRequestSchema.omit({ documentRevision: true }))
    .query(async ({ ctx, input }) =>
      ServerRuntime.runPromise(
        Effect.gen(function* () {
          const vertexAi = yield* VertexAi;
          return yield* quoteWorkflowExecution({
            request: input,
            userId: ctx.session.user.id,
            vertexAi,
          });
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      }),
    ),

  startExecution: protectedProcedure
    .input(workflowExecutionRequestSchema)
    .mutation(async ({ ctx, input }) => {
      const request = input as StartWorkflowExecutionRequest;
      const userId = ctx.session.user.id;

      return ServerRuntime.runPromise(
        Effect.gen(function* () {
          const workflowExecutionService = yield* WorkflowExecutionService;
          return yield* workflowExecutionService.startRun(userId, request);
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      });
    }),

  executionEvents: protectedProcedure
    .input(workflowExecutionEventsSchema)
    .subscription(async function* ({ ctx, input, signal }) {
      const pendingRuns: WorkflowExecutionStatusResponse[] = [];
      let resolveNextRun: (() => void) | undefined;

      const subscription = await ServerRuntime.runPromise(
        Effect.gen(function* () {
          const workflowRunStore = yield* WorkflowRunStore;
          return yield* workflowRunStore.subscribe(
            input.runId,
            ctx.session.user.id,
            (run) => {
              pendingRuns.push(run);
              resolveNextRun?.();
            },
          );
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      });

      try {
        yield subscription.initialRun;

        if (isTerminalStatus(subscription.initialRun.status)) {
          return;
        }

        while (!signal?.aborted) {
          const nextRun = pendingRuns.shift();
          if (nextRun) {
            yield nextRun;

            if (isTerminalStatus(nextRun.status)) {
              return;
            }

            continue;
          }

          await new Promise<void>((resolve) => {
            const abortHandler = () => {
              signal?.removeEventListener("abort", abortHandler);
              resolveNextRun = undefined;
              resolve();
            };

            resolveNextRun = () => {
              signal?.removeEventListener("abort", abortHandler);
              resolveNextRun = undefined;
              resolve();
            };

            signal?.addEventListener("abort", abortHandler, { once: true });
          });
        }
      } finally {
        subscription.unsubscribe();
      }
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

  generateImage: protectedProcedure
    .input(
      z.object({
        model: z.enum(IMAGE_MODEL_IDS),
        mode: z.string().nullable(),
        prompt: z.string(),
        referenceImages: z.array(workflowAssetSchema).optional(),
        aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ServerRuntime.runPromise(
        Effect.gen(function* () {
          const vertexAi = yield* VertexAi;
          return yield* vertexAi.generateImagesWithNanoBananaPro({
            ownerUserId: ctx.session.user.id,
            request: input,
          });
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      }),
    ),

  generateVideo: protectedProcedure
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
    .mutation(async ({ ctx, input }) =>
      ServerRuntime.runPromise(
        Effect.gen(function* () {
          const vertexAi = yield* VertexAi;
          return yield* vertexAi.generateVideosWithVeo31({
            ownerUserId: ctx.session.user.id,
            request: input,
          });
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      }),
    ),

  generateLlm: protectedProcedure
    .input(
      z.object({
        model: z.enum(LLM_MODEL_IDS),
        mode: z.string().nullable(),
        prompt: z.string(),
        systemPrompt: z.string().nullable().optional(),
        referenceImages: z.array(workflowAssetSchema).optional(),
        temperature: z.number().min(0).max(2).optional(),
        thinkingLevel: z.enum(LLM_THINKING_LEVELS).optional(),
        maxOutputTokens: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ServerRuntime.runPromise(
        Effect.gen(function* () {
          const vertexAi = yield* VertexAi;
          return yield* vertexAi.generateTextWithGemini3Flash({
            ownerUserId: ctx.session.user.id,
            request: input,
          });
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      }),
    ),
});
