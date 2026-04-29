import { Effect } from "effect";
import { z } from "zod";

import { ServerRuntime } from "~/effect/server/runtime";
import {
  deserializeStoredWorkflowDocument,
  deserializeStoredWorkflowGraphDocument,
  type WorkflowDocument,
  type WorkflowGraphDocument,
} from "~/lib/workflow/document";
import { buildWorkflowOutputProjection } from "~/lib/workflow/execution/artifact-projection";
import type {
  StartWorkflowExecutionRequest,
  WorkflowExecutionStatus,
  WorkflowExecutionStatusResponse,
} from "~/lib/workflow/execution/types";
import { toTRPCError } from "~/server/api/errors";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { WorkflowArtifactStore } from "~/server/workflow/artifact-store";
import { WorkflowCreditsService } from "~/server/workflow/credits";
import { WorkflowExecutionService } from "~/server/workflow/execution-service";
import { WorkflowExecutionStore } from "~/server/workflow/execution-store";
import {
  getWorkflowProject,
  saveWorkflowProjectDocument,
} from "~/server/workflow/projects";
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
    clientExecutionId: z.string().nullable().optional(),
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

const workflowExecutionQuoteRequestSchema = z
  .object({
    projectId: z.string().min(1),
    target: workflowExecutionTargetSchema,
    documentRevision: z.number().nullable().optional(),
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
  executionId: z.string(),
});

const workflowReviewOutputDecisionSchema = z.object({
  outputIndex: z.number().int().nonnegative(),
  reviewNodeId: z.string().min(1),
  executionId: z.string().min(1),
});

const saveWorkflowProjectSchema = z.object({
  document: workflowGraphDocumentSchema,
  documentRevision: z.number().int().nonnegative(),
  projectId: z.string().min(1),
});

function isTerminalStatus(status: WorkflowExecutionStatus) {
  return status === "success" || status === "error";
}

function projectExecutionState(
  run: WorkflowExecutionStatusResponse,
  userId: string,
) {
  return ServerRuntime.runPromise(
    Effect.gen(function* () {
      const workflowArtifactStore = yield* WorkflowArtifactStore;
      const artifacts = yield* workflowArtifactStore.getOutputArtifacts({
        ownerUserId: userId,
        executionId: run.executionId,
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
        document: buildWorkflowOutputProjection({
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
          return yield* workflowStorage.listWorkflowAssets({
            ownerUserId: ctx.session.user.id,
            workflowId: input.projectId,
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
            const workflowExecutionStore = yield* WorkflowExecutionStore;
            return yield* workflowExecutionStore.getProjectLockedNodeIds({
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
          return yield* workflowExecutionService.startExecution(
            userId,
            request,
          );
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      });
    }),

  quoteExecution: protectedProcedure
    .input(workflowExecutionQuoteRequestSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      return ServerRuntime.runPromise(
        Effect.gen(function* () {
          const workflowExecutionService = yield* WorkflowExecutionService;
          return yield* workflowExecutionService.quoteExecution(userId, input);
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      });
    }),

  executionEvents: protectedProcedure
    .input(workflowExecutionEventsSchema)
    .subscription(async function* ({ ctx, input, signal }) {
      const pendingExecutions: WorkflowExecutionStatusResponse[] = [];
      let resolveNextExecution: (() => void) | undefined;

      const subscription = await ServerRuntime.runPromise(
        Effect.gen(function* () {
          const workflowExecutionStore = yield* WorkflowExecutionStore;
          return yield* workflowExecutionStore.subscribe(
            input.executionId,
            ctx.session.user.id,
            (run) => {
              pendingExecutions.push(run);
              resolveNextExecution?.();
            },
          );
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      });

      try {
        const initialExecution = await projectExecutionState(
          subscription.initialExecution,
          ctx.session.user.id,
        );
        yield initialExecution;

        if (isTerminalStatus(initialExecution.status)) {
          return;
        }

        while (!signal?.aborted) {
          const nextExecution = pendingExecutions.shift();
          if (nextExecution) {
            const projectedExecution = await projectExecutionState(
              nextExecution,
              ctx.session.user.id,
            );
            yield projectedExecution;

            if (isTerminalStatus(projectedExecution.status)) {
              return;
            }

            continue;
          }

          await new Promise<void>((resolve) => {
            const abortHandler = () => {
              signal?.removeEventListener("abort", abortHandler);
              resolveNextExecution = undefined;
              resolve();
            };

            resolveNextExecution = () => {
              signal?.removeEventListener("abort", abortHandler);
              resolveNextExecution = undefined;
              resolve();
            };

            signal?.addEventListener("abort", abortHandler, { once: true });
          });
        }
      } finally {
        subscription.unsubscribe();
      }
    }),

  approveReviewOutput: protectedProcedure
    .input(workflowReviewOutputDecisionSchema)
    .mutation(async ({ ctx, input }) =>
      ServerRuntime.runPromise(
        Effect.gen(function* () {
          const workflowExecutionService = yield* WorkflowExecutionService;
          return yield* workflowExecutionService.approveReviewOutput({
            outputIndex: input.outputIndex,
            reviewNodeId: input.reviewNodeId,
            executionId: input.executionId,
            userId: ctx.session.user.id,
          });
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      }),
    ),

  rejectReviewOutput: protectedProcedure
    .input(workflowReviewOutputDecisionSchema)
    .mutation(async ({ ctx, input }) =>
      ServerRuntime.runPromise(
        Effect.gen(function* () {
          const workflowExecutionService = yield* WorkflowExecutionService;
          return yield* workflowExecutionService.rejectReviewOutput({
            outputIndex: input.outputIndex,
            reviewNodeId: input.reviewNodeId,
            executionId: input.executionId,
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
