import { Effect } from "effect";
import { z } from "zod";

import { ServerRuntime } from "~/effect/server/runtime";
import {
  deserializeStoredWorkflowDocument,
  deserializeStoredWorkflowGraphDocument,
  type WorkflowDocument,
  type WorkflowGraphDocument,
} from "~/lib/workflow/document";
import { buildWorkflowRunProjection } from "~/lib/workflow/execution/artifact-projection";
import type {
  StartWorkflowExecutionRequest,
  WorkflowExecutionStatusResponse,
  WorkflowRunStatus,
} from "~/lib/workflow/execution/types";
import { toTRPCError } from "~/server/api/errors";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { WorkflowArtifactStore } from "~/server/workflow/artifact-store";
import { WorkflowCreditsService } from "~/server/workflow/credits";
import { WorkflowExecutionService } from "~/server/workflow/execution-service";
import {
  getWorkflowProject,
  saveWorkflowProjectDocument,
} from "~/server/workflow/projects";
import { WorkflowRunStore } from "~/server/workflow/run-store";
import { WorkflowStorage } from "~/server/workflow/storage";

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

const workflowGraphDocumentSchema = z
  .custom<WorkflowGraphDocument>(
    (value) => Boolean(deserializeStoredWorkflowGraphDocument(value)),
    "Invalid workflow graph document.",
  )
  .transform(
    (value) =>
      deserializeStoredWorkflowGraphDocument(value) as NonNullable<
        ReturnType<typeof deserializeStoredWorkflowGraphDocument>
      >,
  );

const workflowExecutionTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("selected-or-all"),
  }),
  z.object({
    type: z.literal("node"),
    nodeId: z.string().min(1),
  }),
]);

const workflowExecutionRequestSchema = z
  .object({
    document: workflowDocumentSchema,
    projectId: z.string().min(1),
    target: workflowExecutionTargetSchema,
    clientRunId: z.string().nullable().optional(),
    documentRevision: z.number().nullable().optional(),
    idempotencyKey: z.string().nullable().optional(),
    selection: z
      .object({
        nodeIds: z.array(z.string().min(1)),
      })
      .nullable()
      .optional(),
  })
  .strict();

const workflowExecutionEventsSchema = z.object({
  lastEventId: z.string().nullish(),
  runId: z.string(),
});

const workflowReviewLaneDecisionSchema = z.object({
  laneIndex: z.number().int().nonnegative(),
  reviewNodeId: z.string().min(1),
  runId: z.string().min(1),
});

const saveWorkflowProjectSchema = z.object({
  document: workflowGraphDocumentSchema,
  documentRevision: z.number().int().nonnegative(),
  projectId: z.string().min(1),
});

function isTerminalStatus(status: WorkflowRunStatus) {
  return status === "success" || status === "error";
}

function projectExecutionState(
  run: WorkflowExecutionStatusResponse,
  userId: string,
) {
  return ServerRuntime.runPromise(
    Effect.gen(function* () {
      const workflowArtifactStore = yield* WorkflowArtifactStore;
      const artifacts = yield* workflowArtifactStore.getRunArtifacts({
        ownerUserId: userId,
        runId: run.runId,
      });
      const projectId = run.requestContext?.projectId?.trim();
      const project = projectId
        ? yield* Effect.tryPromise({
            try: () =>
              getWorkflowProject({
                ownerUserId: userId,
                projectId,
              }),
            catch: (cause) => cause,
          }).pipe(Effect.catchAll(() => Effect.succeed(null)))
        : null;
      const document = project?.document ?? run.document;

      return {
        ...run,
        document: buildWorkflowRunProjection({
          artifacts,
          document,
        }),
      } satisfies WorkflowExecutionStatusResponse;
    }),
  );
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
        const initialRun = await projectExecutionState(
          subscription.initialRun,
          ctx.session.user.id,
        );
        yield initialRun;

        if (isTerminalStatus(initialRun.status)) {
          return;
        }

        while (!signal?.aborted) {
          const nextRun = pendingRuns.shift();
          if (nextRun) {
            const projectedRun = await projectExecutionState(
              nextRun,
              ctx.session.user.id,
            );
            yield projectedRun;

            if (isTerminalStatus(projectedRun.status)) {
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

  approveReviewLane: protectedProcedure
    .input(workflowReviewLaneDecisionSchema)
    .mutation(async ({ ctx, input }) =>
      ServerRuntime.runPromise(
        Effect.gen(function* () {
          const workflowExecutionService = yield* WorkflowExecutionService;
          return yield* workflowExecutionService.approveReviewLane({
            laneIndex: input.laneIndex,
            reviewNodeId: input.reviewNodeId,
            runId: input.runId,
            userId: ctx.session.user.id,
          });
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      }),
    ),

  rejectReviewLane: protectedProcedure
    .input(workflowReviewLaneDecisionSchema)
    .mutation(async ({ ctx, input }) =>
      ServerRuntime.runPromise(
        Effect.gen(function* () {
          const workflowExecutionService = yield* WorkflowExecutionService;
          return yield* workflowExecutionService.rejectReviewLane({
            laneIndex: input.laneIndex,
            reviewNodeId: input.reviewNodeId,
            runId: input.runId,
            userId: ctx.session.user.id,
          });
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      }),
    ),

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
});
