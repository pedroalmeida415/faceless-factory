import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";
import {
  getErrorMessage,
  WorkflowAuthorizationError,
  type WorkflowCreditsError,
  WorkflowInfrastructureError,
  type WorkflowRunNotFoundError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import { executeWorkflow } from "~/lib/workflow/execution/core";
import {
  buildWorkflowExecutionStatusResponse,
  createWorkflowExecutionRuntimeState,
} from "~/lib/workflow/execution/runtime-state";
import { extractWorkflowExecutionSubgraph } from "~/lib/workflow/execution/subgraph";
import { resolveWorkflowExecutionTargets } from "~/lib/workflow/execution/target-resolution";
import type {
  StartWorkflowExecutionRequest,
  WorkflowExecutionPortError,
  WorkflowExecutionStatusResponse,
} from "~/lib/workflow/execution/types";
import { isGeneratorNodeKind } from "~/lib/workflow/types";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";
import { WorkflowCreditsService } from "~/server/workflow/credits";
import { quoteWorkflowExecution } from "~/server/workflow/pricing";
import {
  getWorkflowProject,
  persistWorkflowExecutionResults,
} from "~/server/workflow/projects";
import { enqueueWorkflowExecutionJob } from "~/server/workflow/queue";
import { WorkflowRunStore } from "~/server/workflow/run-store";
import { VertexAi } from "~/server/workflow/vertex";

export class WorkflowExecutionService extends Context.Tag(
  "WorkflowExecutionService",
)<
  WorkflowExecutionService,
  {
    readonly startRun: (
      userId: string,
      request: StartWorkflowExecutionRequest,
    ) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowExecutionPortError
      | WorkflowInfrastructureError
      | WorkflowValidationError
    >;
    readonly failRun: (params: {
      message: string;
      runId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowInfrastructureError
      | WorkflowRunNotFoundError
    >;
    readonly executeRun: (
      runId: string,
      userId: string,
      request: StartWorkflowExecutionRequest,
    ) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowExecutionPortError
      | WorkflowInfrastructureError
      | WorkflowRunNotFoundError
    >;
  }
>() {
  static readonly functions = Effect.serviceFunctions(this);

  static readonly Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const vertexAi = yield* VertexAi;
      const workflowCreditsService = yield* WorkflowCreditsService;
      const workflowRunStore = yield* WorkflowRunStore;

      const failRun = (params: {
        message: string;
        runId: string;
        userId: string;
      }) =>
        Effect.gen(function* () {
          const currentRun = yield* workflowRunStore.getRun({
            runId: params.runId,
            userId: params.userId,
          });

          if (
            currentRun.status === "error" ||
            currentRun.status === "success"
          ) {
            return currentRun;
          }

          const credits = yield* workflowCreditsService.refundExecution({
            executionId: params.runId,
            reason: params.message,
            userId: params.userId,
          });

          return yield* workflowRunStore.updateRun({
            ...currentRun,
            activity: params.message,
            credits,
            runtime: {
              ...currentRun.runtime,
              activity: params.message,
              error: params.message,
              finishedAt:
                currentRun.runtime.finishedAt ?? new Date().toISOString(),
            },
            status: "error",
          });
        });

      const startRun = (
        userId: string,
        request: StartWorkflowExecutionRequest,
      ) =>
        Effect.gen(function* () {
          const projectId = request.projectId?.trim();
          if (!projectId) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "A workflow project is required to start execution.",
              }),
            );
          }

          if (
            request.documentRevision === null ||
            request.documentRevision === undefined
          ) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "Workflow project must be saved before execution starts.",
              }),
            );
          }

          const project = yield* Effect.tryPromise({
            try: () =>
              getWorkflowProject({
                ownerUserId: userId,
                projectId,
              }),
            catch: (cause) =>
              cause instanceof WorkflowAuthorizationError ||
              cause instanceof WorkflowValidationError
                ? cause
                : new WorkflowInfrastructureError({
                    message: getErrorMessage(cause),
                    cause,
                  }),
          });

          if (project.documentRevision !== request.documentRevision) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "Workflow project changed before execution. Save again and retry.",
              }),
            );
          }

          const runId = randomUUID();
          const targetNodeIds = resolveWorkflowExecutionTargets(
            project.document,
            request.selection?.nodeIds ?? [],
            request.target,
          );

          WorkflowGraphValidator.validateExecutionTargets(
            project.document,
            targetNodeIds,
          );

          const submittedRequest = {
            ...request,
            documentRevision: project.documentRevision,
            document: extractWorkflowExecutionSubgraph(
              project.document,
              targetNodeIds,
            ),
            projectId,
          } satisfies StartWorkflowExecutionRequest;
          const executionNodeIds = submittedRequest.document.nodes
            .filter((node) => isGeneratorNodeKind(node.kind))
            .map((node) => node.id);
          const priceQuote = yield* quoteWorkflowExecution({
            request: submittedRequest,
            userId,
          });
          const credits = yield* workflowCreditsService.debitExecution({
            amount: priceQuote.totalCost,
            executionId: runId,
            reason: "Workflow execution started.",
            userId,
          });
          const initialRun = buildWorkflowExecutionStatusResponse({
            runId,
            targetNodeIds: executionNodeIds,
            projectDocumentRevision: project.documentRevision,
            document: submittedRequest.document,
            runtime: createWorkflowExecutionRuntimeState(
              submittedRequest.document,
              "Queued workflow run.",
            ),
            credits,
            status: "queued",
          });

          const run = yield* workflowRunStore
            .createRun({
              ownerUserId: userId,
              projectId,
              run: initialRun,
            })
            .pipe(
              Effect.catchAll((error) =>
                workflowCreditsService
                  .refundExecution({
                    executionId: runId,
                    reason: "Workflow execution failed before queueing.",
                    userId,
                  })
                  .pipe(
                    Effect.catchAll((cleanupError) => {
                      console.error(
                        "Failed to refund credits after run creation failure",
                        cleanupError,
                      );
                      return Effect.void;
                    }),
                    Effect.zipRight(Effect.fail(error)),
                  ),
              ),
            );

          yield* Effect.tryPromise({
            try: () =>
              enqueueWorkflowExecutionJob({
                request: submittedRequest,
                runId,
                userId,
              }),
            catch: (cause) =>
              new WorkflowInfrastructureError({
                message: getErrorMessage(cause),
                cause,
              }),
          }).pipe(
            Effect.catchAll((error) =>
              failRun({
                message: "Failed to queue workflow run.",
                runId,
                userId,
              }).pipe(
                Effect.catchAll((cleanupError) => {
                  console.error(
                    "Failed to mark workflow run as errored after queue failure",
                    cleanupError,
                  );
                  return Effect.void;
                }),
                Effect.zipRight(Effect.fail(error)),
              ),
            ),
          );

          return run;
        });

      const executeRun = (
        runId: string,
        userId: string,
        request: StartWorkflowExecutionRequest,
      ) =>
        executeWorkflow({
          request,
          runId,
          ports: {
            generateImage: (imageRequest) =>
              vertexAi.generateImagesWithNanoBananaPro({
                ownerUserId: userId,
                projectId: request.projectId ?? null,
                request: imageRequest,
              }),
            generateVideo: (videoRequest) =>
              vertexAi.generateVideosWithVeo31({
                ownerUserId: userId,
                projectId: request.projectId ?? null,
                request: videoRequest,
              }),
            generateLlm: (llmRequest) =>
              vertexAi.generateTextWithGemini3Flash({
                ownerUserId: userId,
                projectId: request.projectId ?? null,
                request: llmRequest,
              }),
            onCompleted: ({ document, targetNodeIds }) =>
              Effect.tryPromise({
                try: async () => {
                  const projectId = request.projectId?.trim();
                  if (!projectId) {
                    throw new WorkflowInfrastructureError({
                      message:
                        "Workflow project is missing from execution context.",
                    });
                  }

                  return persistWorkflowExecutionResults({
                    executionDocument: document,
                    ownerUserId: userId,
                    projectId,
                    targetNodeIds,
                  });
                },
                catch: (cause) =>
                  new WorkflowInfrastructureError({
                    message: getErrorMessage(cause),
                    cause,
                  }),
              }),
            onStateChange: (state) =>
              Effect.gen(function* () {
                const credits = yield* workflowCreditsService.getRunSummary({
                  runId,
                  userId,
                });
                yield* workflowRunStore
                  .updateRun({
                    ...state,
                    credits,
                  })
                  .pipe(Effect.orDie, Effect.asVoid);
              }).pipe(Effect.orDie),
          },
        }).pipe(
          Effect.tap((state) =>
            Effect.gen(function* () {
              const credits = yield* workflowCreditsService.alignExecutionCost({
                executionId: runId,
                reason: "Workflow execution settled.",
                targetCost: state.finalCostCredits ?? 0,
                userId,
              });
              return yield* workflowRunStore.updateRun({
                ...state,
                credits,
              });
            }),
          ),
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              const currentRun = yield* workflowRunStore.getRun({
                runId,
                userId,
              });

              if (currentRun.status === "success") {
                const credits = yield* workflowCreditsService
                  .getRunSummary({
                    runId,
                    userId,
                  })
                  .pipe(
                    Effect.catchAll(() => Effect.succeed(currentRun.credits)),
                  );
                const nextRun = {
                  ...currentRun,
                  credits,
                };

                return yield* workflowRunStore
                  .updateRun(nextRun)
                  .pipe(Effect.catchAll(() => Effect.succeed(nextRun)));
              }

              const credits = yield* workflowCreditsService.refundExecution({
                executionId: runId,
                reason: getErrorMessage(error),
                userId,
              });
              yield* workflowRunStore.updateRun({
                ...currentRun,
                credits,
              });
              return yield* Effect.fail(error);
            }),
          ),
        );

      return WorkflowExecutionService.of({
        executeRun,
        failRun,
        startRun,
      });
    }),
  );
}
