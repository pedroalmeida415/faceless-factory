import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";
import { updateWorkflowDocumentNode } from "~/lib/workflow/document";
import {
  getErrorMessage,
  WorkflowAuthorizationError,
  type WorkflowCreditsError,
  WorkflowInfrastructureError,
  type WorkflowRunNotFoundError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import {
  clearReviewDescendantOutputLane,
  estimateGeneratorReviewLaneRegenerationCreditCost,
  executeWorkflow,
  regenerateGeneratorReviewLane,
} from "~/lib/workflow/execution/core";
import { mergeWorkflowExecutionDocument } from "~/lib/workflow/execution/result-merge";
import {
  buildWorkflowExecutionStatusResponse,
  createWorkflowExecutionRuntimeState,
} from "~/lib/workflow/execution/runtime-state";
import {
  buildWorkflowExecutionPlan,
  collectDownstreamWorkflowGeneratorNodeIds,
  collectExecutableWorkflowGeneratorNodeIds,
  extractWorkflowExecutionSubgraph,
} from "~/lib/workflow/execution/subgraph";
import { resolveWorkflowExecutionTargets } from "~/lib/workflow/execution/target-resolution";
import type {
  StartWorkflowExecutionRequest,
  WorkflowExecutionPortError,
  WorkflowExecutionStatusResponse,
} from "~/lib/workflow/execution/types";
import { estimateWorkflowExecution } from "~/lib/workflow/pricing";
import { isReviewFullyApproved } from "~/lib/workflow/review-state";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";
import { WorkflowCreditsService } from "~/server/workflow/credits";
import {
  getWorkflowProject,
  persistWorkflowExecutionResults,
} from "~/server/workflow/projects";
import {
  createWorkflowContinuationJobId,
  createWorkflowExecutionLaneJobId,
  createWorkflowReviewRegenerationJobId,
  enqueueWorkflowExecutionJob,
  enqueueWorkflowReviewRegenerationJob,
} from "~/server/workflow/queue";
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
    readonly approveReviewLane: (params: {
      laneIndex: number;
      reviewNodeId: string;
      runId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowExecutionPortError
      | WorkflowInfrastructureError
      | WorkflowRunNotFoundError
      | WorkflowValidationError
    >;
    readonly rejectReviewLane: (params: {
      laneIndex: number;
      reviewNodeId: string;
      runId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowExecutionPortError
      | WorkflowInfrastructureError
      | WorkflowRunNotFoundError
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
    readonly executeReviewLaneRegeneration: (params: {
      laneIndex: number;
      reviewNodeId: string;
      runId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowExecutionPortError
      | WorkflowInfrastructureError
      | WorkflowRunNotFoundError
      | WorkflowValidationError
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

      const buildContinuationRequest = (
        run: WorkflowExecutionStatusResponse,
        reviewLaneFilter?: StartWorkflowExecutionRequest["reviewLaneFilter"],
      ) =>
        Effect.gen(function* () {
          const context = run.requestContext;
          if (!context) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "Workflow run cannot be resumed without request context.",
              }),
            );
          }

          const downstreamTargetNodeIds = reviewLaneFilter
            ? collectDownstreamWorkflowGeneratorNodeIds(
                run.document,
                reviewLaneFilter.reviewNodeId,
                new Set(run.targetNodeIds),
              )
            : null;

          return {
            ...context,
            accruedCostCredits: run.accruedCostCredits,
            document: run.document,
            reviewLaneFilter: reviewLaneFilter ?? null,
            selection: downstreamTargetNodeIds
              ? { nodeIds: downstreamTargetNodeIds }
              : context.selection,
            target: downstreamTargetNodeIds
              ? { type: "selected-or-all" as const }
              : context.target,
          } satisfies StartWorkflowExecutionRequest;
        });

      const hasLaneContinuationTargets = (
        run: WorkflowExecutionStatusResponse,
        reviewNodeId: string,
      ) =>
        collectDownstreamWorkflowGeneratorNodeIds(
          run.document,
          reviewNodeId,
          new Set(run.targetNodeIds),
        ).length > 0;

      const getExecutionLaneCount = (
        document: StartWorkflowExecutionRequest["document"],
        targetNodeIds: string[],
      ) => {
        const plan = buildWorkflowExecutionPlan(document, targetNodeIds);
        return Math.max(
          1,
          ...plan.executableNodeIds.map(
            (nodeId) =>
              plan.generatorIterationById.get(nodeId)?.iterations ?? 1,
          ),
        );
      };

      const hasLaneAccumulator = (
        document: StartWorkflowExecutionRequest["document"],
      ) => document.nodes.some((node) => node.kind === "laneAccumulator");

      const isExecutionLaneComplete = (
        run: WorkflowExecutionStatusResponse,
        laneIndex: number,
      ) => {
        const plan = buildWorkflowExecutionPlan(
          run.document,
          run.targetNodeIds,
        );
        const expectedNodeIds = run.targetNodeIds.filter(
          (nodeId) =>
            (plan.generatorIterationById.get(nodeId)?.iterations ?? 1) >
            laneIndex,
        );
        return expectedNodeIds.every((nodeId) => {
          const node = run.document.nodes.find(
            (candidate) => candidate.id === nodeId,
          );
          if (
            node?.kind === "imageGenerator" ||
            node?.kind === "videoGenerator"
          ) {
            return (node.outputLanes[laneIndex]?.length ?? 0) > 0;
          }
          if (node?.kind === "llmGenerator") {
            return Boolean(node.outputLanes[laneIndex]?.trim());
          }
          return false;
        });
      };

      const areExecutionLanesComplete = (
        run: WorkflowExecutionStatusResponse,
        laneCount: number,
      ) =>
        Array.from({ length: laneCount }, (_, laneIndex) => laneIndex).every(
          (laneIndex) => isExecutionLaneComplete(run, laneIndex),
        );

      const hasLaneOutput = (
        run: WorkflowExecutionStatusResponse,
        laneIndex: number,
      ) =>
        run.targetNodeIds.some((nodeId) => {
          const node = run.document.nodes.find(
            (candidate) => candidate.id === nodeId,
          );
          if (
            node?.kind === "imageGenerator" ||
            node?.kind === "videoGenerator"
          ) {
            return (node.outputLanes[laneIndex]?.length ?? 0) > 0;
          }
          if (node?.kind === "llmGenerator") {
            return Boolean(node.outputLanes[laneIndex]?.trim());
          }
          return false;
        });

      const hasApprovedReviewLanes = (
        run: WorkflowExecutionStatusResponse,
        reviewNodeId: string,
      ) => {
        const reviewNode = run.document.nodes.find(
          (node) => node.id === reviewNodeId,
        );

        return isReviewFullyApproved(reviewNode);
      };

      const getReviewLaneForDecision = (params: {
        decision: "approve" | "regenerate";
        laneIndex: number;
        reviewNodeId: string;
        run: WorkflowExecutionStatusResponse;
      }) => {
        if (params.run.status !== "waiting_for_review") {
          return Effect.fail(
            new WorkflowValidationError({
              message: "Workflow run is not waiting for human review.",
            }),
          );
        }

        const reviewNode = params.run.document.nodes.find(
          (node) => node.id === params.reviewNodeId,
        );
        if (
          !reviewNode ||
          (reviewNode.kind !== "imageGenerator" &&
            reviewNode.kind !== "videoGenerator" &&
            reviewNode.kind !== "llmGenerator")
        ) {
          return Effect.fail(
            new WorkflowValidationError({
              message: "Reviewed generator node not found.",
            }),
          );
        }

        const lane = reviewNode.review.lanes.find(
          (candidate) => candidate.laneIndex === params.laneIndex,
        );
        if (!lane) {
          return Effect.fail(
            new WorkflowValidationError({
              message: `Review lane ${params.laneIndex + 1} does not exist.`,
            }),
          );
        }

        if (
          params.decision === "approve" &&
          lane.status !== "pending" &&
          lane.status !== "approved"
        ) {
          return Effect.fail(
            new WorkflowValidationError({
              message: `Review lane ${params.laneIndex + 1} is not pending approval.`,
            }),
          );
        }

        if (
          params.decision === "regenerate" &&
          lane.status !== "pending" &&
          lane.status !== "regenerating"
        ) {
          return Effect.fail(
            new WorkflowValidationError({
              message: `Review lane ${params.laneIndex + 1} is not pending regeneration.`,
            }),
          );
        }

        return Effect.succeed({ lane, reviewNode });
      };

      const toPersistenceError = (cause: unknown) =>
        cause instanceof WorkflowAuthorizationError ||
        cause instanceof WorkflowInfrastructureError ||
        cause instanceof WorkflowValidationError
          ? cause
          : new WorkflowInfrastructureError({
              message: getErrorMessage(cause),
              cause,
            });

      const withProjectDocumentRevision = (
        run: WorkflowExecutionStatusResponse,
        documentRevision: number,
      ) => ({
        ...run,
        projectDocumentRevision: documentRevision,
        requestContext: run.requestContext
          ? {
              ...run.requestContext,
              documentRevision,
            }
          : null,
      });

      const persistRunDocument = (
        run: WorkflowExecutionStatusResponse,
        userId: string,
        mergeExecutionLaneIndex?: number | null,
      ) =>
        Effect.tryPromise({
          try: async () => {
            const projectId = run.requestContext?.projectId?.trim();
            if (!projectId) {
              throw new WorkflowInfrastructureError({
                message: "Workflow project is missing from execution context.",
              });
            }

            return persistWorkflowExecutionResults({
              executionDocument: run.document,
              mergeExecutionLaneIndex,
              ownerUserId: userId,
              projectId,
              targetNodeIds: run.targetNodeIds,
            });
          },
          catch: toPersistenceError,
        });

      const getFilteredContinuationCostDelta = (
        state: WorkflowExecutionStatusResponse,
        request: StartWorkflowExecutionRequest,
      ) =>
        Math.max(
          0,
          state.accruedCostCredits - (request.accruedCostCredits ?? 0),
        );

      const mergeLaneScopedExecutionState = (params: {
        accruedCostCredits: number;
        currentRun: WorkflowExecutionStatusResponse;
        laneIndex: number;
        state: WorkflowExecutionStatusResponse;
      }) => ({
        ...params.state,
        accruedCostCredits: params.accruedCostCredits,
        document: mergeWorkflowExecutionDocument({
          currentDocument: params.currentRun.document,
          executionDocument: params.state.document,
          mergeExecutionLaneIndex: params.laneIndex,
          targetNodeIds: params.state.targetNodeIds,
        }),
        projectDocumentRevision:
          params.currentRun.projectDocumentRevision ??
          params.state.projectDocumentRevision,
        requestContext: params.state.requestContext
          ? {
              ...params.state.requestContext,
              accruedCostCredits: params.accruedCostCredits,
              documentRevision:
                params.currentRun.requestContext?.documentRevision ??
                params.state.requestContext.documentRevision,
            }
          : null,
        targetNodeIds: params.currentRun.targetNodeIds,
      });

      const hydrateRunDocumentFromProject = (
        run: WorkflowExecutionStatusResponse,
        userId: string,
      ) =>
        Effect.gen(function* () {
          const projectId = run.requestContext?.projectId?.trim();
          if (!projectId) {
            return run.document;
          }

          const project = yield* Effect.tryPromise({
            try: () =>
              getWorkflowProject({
                ownerUserId: userId,
                projectId,
              }),
            catch: toPersistenceError,
          });

          return mergeWorkflowExecutionDocument({
            currentDocument: project.document,
            executionDocument: run.document,
            targetNodeIds: run.targetNodeIds,
          });
        });

      const settleRunCost = (params: {
        reason: string;
        run: WorkflowExecutionStatusResponse;
        targetCost?: number;
        userId: string;
      }) =>
        workflowCreditsService.alignExecutionCost({
          executionId: params.run.runId,
          reason: params.reason,
          targetCost: params.targetCost ?? params.run.accruedCostCredits,
          userId: params.userId,
        });

      const getRequestLaneIndex = (request: StartWorkflowExecutionRequest) =>
        request.reviewLaneFilter?.laneIndex ??
        request.executionLaneFilter?.laneIndex ??
        null;

      const reserveContinuationCredits = (params: {
        run: WorkflowExecutionStatusResponse;
        userId: string;
        reviewLaneFilter?: StartWorkflowExecutionRequest["reviewLaneFilter"];
      }) =>
        Effect.gen(function* () {
          const request = yield* buildContinuationRequest(
            params.run,
            params.reviewLaneFilter,
          );
          const quote = yield* Effect.try({
            try: () => estimateWorkflowExecution(request),
            catch: (cause) =>
              cause instanceof WorkflowValidationError
                ? cause
                : new WorkflowInfrastructureError({
                    message: getErrorMessage(cause),
                    cause,
                  }),
          });

          return yield* settleRunCost({
            reason: "Workflow review continuation reserved.",
            run: params.run,
            targetCost: params.run.accruedCostCredits + quote.totalCost,
            userId: params.userId,
          });
        });

      const enqueueContinuation = (
        run: WorkflowExecutionStatusResponse,
        userId: string,
        reviewLaneFilter?: StartWorkflowExecutionRequest["reviewLaneFilter"],
      ) =>
        Effect.gen(function* () {
          if (
            reviewLaneFilter &&
            !hasLaneContinuationTargets(run, reviewLaneFilter.reviewNodeId)
          ) {
            return null;
          }

          const request = yield* buildContinuationRequest(
            run,
            reviewLaneFilter,
          );

          return yield* Effect.tryPromise({
            try: () =>
              enqueueWorkflowExecutionJob(
                {
                  request,
                  runId: run.runId,
                  type: "execute-run",
                  userId,
                },
                {
                  jobId: createWorkflowContinuationJobId({
                    laneIndex: reviewLaneFilter?.laneIndex,
                    reviewNodeId: reviewLaneFilter?.reviewNodeId,
                    runId: run.runId,
                  }),
                },
              ),
            catch: (cause) =>
              new WorkflowInfrastructureError({
                message: getErrorMessage(cause),
                cause,
              }),
          });
        });

      const approveReviewLane = (params: {
        laneIndex: number;
        reviewNodeId: string;
        runId: string;
        userId: string;
      }) =>
        Effect.gen(function* () {
          const {
            result: { shouldResume },
            run: waitingRun,
          } = yield* workflowRunStore.updateRunWith({
            runId: params.runId,
            userId: params.userId,
            update: (currentRun) =>
              Effect.gen(function* () {
                yield* getReviewLaneForDecision({
                  decision: "approve",
                  laneIndex: params.laneIndex,
                  reviewNodeId: params.reviewNodeId,
                  run: currentRun,
                });

                const now = new Date().toISOString();
                const document = updateWorkflowDocumentNode(
                  currentRun.document,
                  params.reviewNodeId,
                  (node) => {
                    if (
                      node.kind !== "imageGenerator" &&
                      node.kind !== "videoGenerator" &&
                      node.kind !== "llmGenerator"
                    ) {
                      return node;
                    }

                    return {
                      ...node,
                      review: {
                        ...node.review,
                        lanes: node.review.lanes.map((lane) =>
                          lane.laneIndex === params.laneIndex
                            ? { ...lane, status: "approved" }
                            : lane,
                        ),
                        updatedAt: now,
                      },
                    };
                  },
                );
                const nextRunBase = {
                  ...currentRun,
                  activity: "Human review updated.",
                  document,
                  runtime: {
                    ...currentRun.runtime,
                    activity: "Human review updated.",
                    nodeStateById: {
                      ...currentRun.runtime.nodeStateById,
                      [params.reviewNodeId]: {
                        error: null,
                        status: hasApprovedReviewLanes(
                          { ...currentRun, document },
                          params.reviewNodeId,
                        )
                          ? "success"
                          : "waiting",
                      },
                    },
                  },
                  status: "waiting_for_review" as const,
                } satisfies WorkflowExecutionStatusResponse;
                const documentRevision = yield* persistRunDocument(
                  nextRunBase,
                  params.userId,
                  params.laneIndex,
                );
                const persistedRunBase = withProjectDocumentRevision(
                  nextRunBase,
                  documentRevision,
                );
                const shouldResume = hasApprovedReviewLanes(
                  persistedRunBase,
                  params.reviewNodeId,
                );
                const activity = shouldResume
                  ? "Human review approved. Queueing workflow resume..."
                  : `Lane ${params.laneIndex + 1} approved. Continuing that lane...`;

                return {
                  result: { shouldResume },
                  run: {
                    ...persistedRunBase,
                    activity,
                    runtime: {
                      ...persistedRunBase.runtime,
                      activity,
                    },
                  },
                };
              }),
          });

          if (shouldResume) {
            if (!hasLaneContinuationTargets(waitingRun, params.reviewNodeId)) {
              const credits = yield* settleRunCost({
                reason: "Workflow review approved.",
                run: waitingRun,
                userId: params.userId,
              });

              return yield* workflowRunStore
                .updateRunWith({
                  runId: params.runId,
                  userId: params.userId,
                  update: (currentRun) =>
                    Effect.succeed({
                      result: null,
                      run: {
                        ...currentRun,
                        activity: "Workflow run finished.",
                        credits,
                        finalCostCredits: currentRun.accruedCostCredits,
                        runtime: {
                          ...currentRun.runtime,
                          activity: "Workflow run finished.",
                          error: null,
                          finishedAt: new Date().toISOString(),
                        },
                        status: "success" as const,
                      },
                    }),
                })
                .pipe(Effect.map(({ run }) => run));
            }

            let reservationFailureRun: WorkflowExecutionStatusResponse | null =
              null;
            const reservedCredits = yield* reserveContinuationCredits({
              run: waitingRun,
              userId: params.userId,
            }).pipe(
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  const { run } = yield* workflowRunStore.updateRunWith({
                    runId: params.runId,
                    userId: params.userId,
                    update: (currentRun) =>
                      Effect.succeed({
                        result: null,
                        run: {
                          ...currentRun,
                          activity: getErrorMessage(error),
                          runtime: {
                            ...currentRun.runtime,
                            activity: getErrorMessage(error),
                          },
                        },
                      }),
                  });
                  reservationFailureRun = run;
                  return null;
                }),
              ),
            );
            if (!reservedCredits) {
              return reservationFailureRun ?? waitingRun;
            }
            let continuationFailureRun: WorkflowExecutionStatusResponse | null =
              null;
            const continuationQueued = yield* enqueueContinuation(
              waitingRun,
              params.userId,
              null,
            ).pipe(
              Effect.as(true),
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  const credits = yield* settleRunCost({
                    reason: getErrorMessage(error),
                    run: waitingRun,
                    targetCost: waitingRun.accruedCostCredits,
                    userId: params.userId,
                  }).pipe(
                    Effect.catchAll(() => Effect.succeed(reservedCredits)),
                  );
                  const { run } = yield* workflowRunStore.updateRunWith({
                    runId: params.runId,
                    userId: params.userId,
                    update: (currentRun) =>
                      Effect.succeed({
                        result: null,
                        run: {
                          ...currentRun,
                          activity: getErrorMessage(error),
                          credits,
                          runtime: {
                            ...currentRun.runtime,
                            activity: getErrorMessage(error),
                          },
                        },
                      }),
                  });
                  continuationFailureRun = run;
                  return false;
                }),
              ),
            );
            if (!continuationQueued) {
              return continuationFailureRun ?? waitingRun;
            }

            return yield* workflowRunStore
              .updateRunWith({
                runId: params.runId,
                userId: params.userId,
                update: (currentRun) =>
                  Effect.succeed({
                    result: null,
                    run: {
                      ...currentRun,
                      activity: "Human review approved. Resuming workflow...",
                      credits: reservedCredits,
                      runtime: {
                        ...currentRun.runtime,
                        activity: "Human review approved. Resuming workflow...",
                      },
                      status: "queued" as const,
                    },
                  }),
              })
              .pipe(Effect.map(({ run }) => run));
          }

          if (!hasLaneContinuationTargets(waitingRun, params.reviewNodeId)) {
            return waitingRun;
          }

          let reservationFailureRun: WorkflowExecutionStatusResponse | null =
            null;
          const reservedCredits = yield* reserveContinuationCredits({
            reviewLaneFilter: {
              laneIndex: params.laneIndex,
              reviewNodeId: params.reviewNodeId,
            },
            run: waitingRun,
            userId: params.userId,
          }).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                const { run } = yield* workflowRunStore.updateRunWith({
                  runId: params.runId,
                  userId: params.userId,
                  update: (currentRun) =>
                    Effect.succeed({
                      result: null,
                      run: {
                        ...currentRun,
                        activity: getErrorMessage(error),
                        runtime: {
                          ...currentRun.runtime,
                          activity: getErrorMessage(error),
                        },
                      },
                    }),
                });
                reservationFailureRun = run;
                return null;
              }),
            ),
          );
          if (!reservedCredits) {
            return reservationFailureRun ?? waitingRun;
          }

          let continuationFailureRun: WorkflowExecutionStatusResponse | null =
            null;
          const continuationQueued = yield* enqueueContinuation(
            waitingRun,
            params.userId,
            {
              laneIndex: params.laneIndex,
              reviewNodeId: params.reviewNodeId,
            },
          ).pipe(
            Effect.as(true),
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                const credits = yield* settleRunCost({
                  reason: getErrorMessage(error),
                  run: waitingRun,
                  targetCost: waitingRun.accruedCostCredits,
                  userId: params.userId,
                }).pipe(Effect.catchAll(() => Effect.succeed(reservedCredits)));
                const { run } = yield* workflowRunStore.updateRunWith({
                  runId: params.runId,
                  userId: params.userId,
                  update: (currentRun) =>
                    Effect.succeed({
                      result: null,
                      run: {
                        ...currentRun,
                        activity: getErrorMessage(error),
                        credits,
                        runtime: {
                          ...currentRun.runtime,
                          activity: getErrorMessage(error),
                        },
                      },
                    }),
                });
                continuationFailureRun = run;
                return false;
              }),
            ),
          );
          if (!continuationQueued) {
            return continuationFailureRun ?? waitingRun;
          }

          return yield* workflowRunStore
            .updateRunWith({
              runId: params.runId,
              userId: params.userId,
              update: (currentRun) =>
                Effect.succeed({
                  result: null,
                  run: {
                    ...currentRun,
                    credits: reservedCredits,
                  },
                }),
            })
            .pipe(Effect.map(({ run }) => run));
        });

      const rejectReviewLane = (params: {
        laneIndex: number;
        reviewNodeId: string;
        runId: string;
        userId: string;
      }) =>
        Effect.gen(function* () {
          const { run: regeneratingRun } =
            yield* workflowRunStore.updateRunWith({
              runId: params.runId,
              userId: params.userId,
              update: (currentRun) =>
                Effect.gen(function* () {
                  const { lane } = yield* getReviewLaneForDecision({
                    decision: "regenerate",
                    laneIndex: params.laneIndex,
                    reviewNodeId: params.reviewNodeId,
                    run: currentRun,
                  });

                  if (lane.status === "regenerating") {
                    return {
                      result: null,
                      run: currentRun,
                    };
                  }

                  const regenerationCostEstimate =
                    yield* estimateGeneratorReviewLaneRegenerationCreditCost({
                      document: currentRun.document,
                      generatorNodeId: params.reviewNodeId,
                    });
                  const reservedCredits = yield* settleRunCost({
                    reason: "Workflow review lane regeneration reserved.",
                    run: currentRun,
                    targetCost:
                      currentRun.accruedCostCredits + regenerationCostEstimate,
                    userId: params.userId,
                  });

                  const now = new Date().toISOString();
                  const regeneratingDocument = clearReviewDescendantOutputLane(
                    updateWorkflowDocumentNode(
                      currentRun.document,
                      params.reviewNodeId,
                      (node) =>
                        node.kind === "imageGenerator" ||
                        node.kind === "videoGenerator" ||
                        node.kind === "llmGenerator"
                          ? {
                              ...node,
                              review: {
                                ...node.review,
                                lanes: node.review.lanes.map((lane) =>
                                  lane.laneIndex === params.laneIndex
                                    ? { ...lane, status: "regenerating" }
                                    : lane,
                                ),
                                updatedAt: now,
                              },
                            }
                          : node,
                    ),
                    params.reviewNodeId,
                    params.laneIndex,
                  );

                  return {
                    result: null,
                    run: {
                      ...currentRun,
                      credits: reservedCredits,
                      document: regeneratingDocument,
                      runtime: {
                        ...currentRun.runtime,
                        activity: `Regenerating lane ${params.laneIndex + 1} for review...`,
                      },
                      status: "waiting_for_review" as const,
                    },
                  };
                }),
            });

          yield* Effect.tryPromise({
            try: () => {
              const reviewNode = regeneratingRun.document.nodes.find(
                (node) => node.id === params.reviewNodeId,
              );
              const regenerationKey =
                reviewNode &&
                (reviewNode.kind === "imageGenerator" ||
                  reviewNode.kind === "videoGenerator" ||
                  reviewNode.kind === "llmGenerator")
                  ? (reviewNode.review.updatedAt ?? "pending")
                  : "pending";
              return enqueueWorkflowReviewRegenerationJob(
                {
                  laneIndex: params.laneIndex,
                  reviewNodeId: params.reviewNodeId,
                  runId: params.runId,
                  type: "regenerate-review-lane",
                  userId: params.userId,
                },
                {
                  jobId: createWorkflowReviewRegenerationJobId({
                    laneIndex: params.laneIndex,
                    regenerationKey,
                    reviewNodeId: params.reviewNodeId,
                    runId: params.runId,
                  }),
                },
              );
            },
            catch: (cause) =>
              new WorkflowInfrastructureError({
                message: getErrorMessage(cause),
                cause,
              }),
          });

          return regeneratingRun;
        });

      const executeReviewLaneRegeneration = (params: {
        laneIndex: number;
        reviewNodeId: string;
        runId: string;
        userId: string;
      }) =>
        Effect.gen(function* () {
          const regeneratingRun = yield* workflowRunStore.getRun({
            runId: params.runId,
            userId: params.userId,
          });
          const regenerationDocument = yield* hydrateRunDocumentFromProject(
            regeneratingRun,
            params.userId,
          );
          const result = yield* regenerateGeneratorReviewLane({
            document: regenerationDocument,
            idempotencyKey: `${params.runId}:regenerate:${params.reviewNodeId}`,
            laneIndex: params.laneIndex,
            ports: {
              generateImage: (imageRequest) =>
                vertexAi.generateImagesWithNanoBananaPro({
                  ownerUserId: params.userId,
                  projectId: regeneratingRun.requestContext?.projectId ?? null,
                  request: imageRequest,
                }),
              generateLlm: (llmRequest) =>
                vertexAi.generateTextWithGemini3Flash({
                  ownerUserId: params.userId,
                  projectId: regeneratingRun.requestContext?.projectId ?? null,
                  request: llmRequest,
                }),
              generateVideo: (videoRequest) =>
                vertexAi.generateVideosWithVeo31({
                  ownerUserId: params.userId,
                  projectId: regeneratingRun.requestContext?.projectId ?? null,
                  request: videoRequest,
                }),
            },
            generatorNodeId: params.reviewNodeId,
          }).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                yield* workflowRunStore.updateRunWith({
                  runId: params.runId,
                  userId: params.userId,
                  update: (currentRun) =>
                    Effect.gen(function* () {
                      const credits = yield* settleRunCost({
                        reason: "Workflow review lane regeneration failed.",
                        run: currentRun,
                        targetCost: currentRun.accruedCostCredits,
                        userId: params.userId,
                      }).pipe(
                        Effect.catchAll(() =>
                          Effect.succeed(currentRun.credits),
                        ),
                      );

                      return {
                        result: null,
                        run: {
                          ...currentRun,
                          credits,
                          document: updateWorkflowDocumentNode(
                            currentRun.document,
                            params.reviewNodeId,
                            (node) =>
                              node.kind === "imageGenerator" ||
                              node.kind === "videoGenerator" ||
                              node.kind === "llmGenerator"
                                ? {
                                    ...node,
                                    review: {
                                      ...node.review,
                                      lanes: node.review.lanes.map((lane) =>
                                        lane.laneIndex === params.laneIndex
                                          ? { ...lane, status: "pending" }
                                          : lane,
                                      ),
                                      updatedAt: new Date().toISOString(),
                                    },
                                  }
                                : node,
                          ),
                          runtime: {
                            ...currentRun.runtime,
                            activity: getErrorMessage(error),
                          },
                        },
                      };
                    }),
                });

                return yield* Effect.fail(error);
              }),
            ),
          );

          return yield* workflowRunStore
            .updateRunWith({
              runId: params.runId,
              userId: params.userId,
              update: (currentRun) =>
                Effect.gen(function* () {
                  const reviewNode = currentRun.document.nodes.find(
                    (node) => node.id === params.reviewNodeId,
                  );
                  const lane =
                    reviewNode &&
                    (reviewNode.kind === "imageGenerator" ||
                      reviewNode.kind === "videoGenerator" ||
                      reviewNode.kind === "llmGenerator")
                      ? reviewNode.review.lanes.find(
                          (candidate) =>
                            candidate.laneIndex === params.laneIndex,
                        )
                      : null;
                  if (lane?.status !== "regenerating") {
                    return yield* Effect.fail(
                      new WorkflowValidationError({
                        message: `Review lane ${params.laneIndex + 1} is no longer regenerating.`,
                      }),
                    );
                  }

                  const document = yield* Effect.try({
                    try: () =>
                      mergeWorkflowExecutionDocument({
                        currentDocument: currentRun.document,
                        executionDocument: result.document,
                        mergeExecutionLaneIndex: params.laneIndex,
                        targetNodeIds: currentRun.targetNodeIds,
                      }),
                    catch: toPersistenceError,
                  });
                  const nextAccruedCostCredits =
                    currentRun.accruedCostCredits + result.costCredits;
                  const credits = yield* settleRunCost({
                    reason: "Workflow review lane regenerated.",
                    run: currentRun,
                    targetCost: nextAccruedCostCredits,
                    userId: params.userId,
                  });
                  const nextRunBase = {
                    ...currentRun,
                    accruedCostCredits: nextAccruedCostCredits,
                    credits,
                    document,
                    runtime: {
                      ...currentRun.runtime,
                      activity: `Lane ${params.laneIndex + 1} regenerated. Review it again.`,
                    },
                    status: "waiting_for_review" as const,
                  } satisfies WorkflowExecutionStatusResponse;
                  const documentRevision = yield* persistRunDocument(
                    nextRunBase,
                    params.userId,
                    params.laneIndex,
                  );

                  return {
                    result: null,
                    run: withProjectDocumentRevision(
                      nextRunBase,
                      documentRevision,
                    ),
                  };
                }),
            })
            .pipe(Effect.map(({ run }) => run));
        });

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

          const settleFailureCost =
            currentRun.status === "waiting_for_review"
              ? settleRunCost({
                  reason: params.message,
                  run: currentRun,
                  targetCost: currentRun.accruedCostCredits,
                  userId: params.userId,
                })
              : workflowCreditsService.refundExecution({
                  executionId: params.runId,
                  reason: params.message,
                  userId: params.userId,
                });
          const credits = yield* settleFailureCost;

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
            status:
              currentRun.status === "waiting_for_review"
                ? "waiting_for_review"
                : "error",
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
          const executionNodeIds = collectExecutableWorkflowGeneratorNodeIds(
            submittedRequest.document,
            targetNodeIds,
          );
          const priceQuote = estimateWorkflowExecution(submittedRequest);
          const credits = yield* workflowCreditsService.debitExecution({
            amount: priceQuote.totalCost,
            executionId: runId,
            reason: "Workflow execution started.",
            userId,
          });
          const initialRun = buildWorkflowExecutionStatusResponse({
            runId,
            targetNodeIds: executionNodeIds,
            accruedCostCredits: 0,
            projectDocumentRevision: project.documentRevision,
            document: submittedRequest.document,
            runtime: createWorkflowExecutionRuntimeState(
              submittedRequest.document,
              "Queued workflow run.",
            ),
            requestContext: {
              accruedCostCredits: 0,
              clientRunId: submittedRequest.clientRunId ?? null,
              documentRevision: submittedRequest.documentRevision ?? null,
              idempotencyKey: submittedRequest.idempotencyKey ?? null,
              projectId,
              selection: submittedRequest.selection ?? null,
              target: submittedRequest.target,
            },
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

          const executionPlan = buildWorkflowExecutionPlan(
            submittedRequest.document,
            targetNodeIds,
          );
          const laneCount = getExecutionLaneCount(
            submittedRequest.document,
            targetNodeIds,
          );
          const shouldSplitLanes =
            laneCount > 1 && !hasLaneAccumulator(submittedRequest.document);

          yield* Effect.tryPromise({
            try: async () => {
              if (shouldSplitLanes) {
                await Promise.all(
                  Array.from({ length: laneCount }, (_, laneIndex) => {
                    const laneTargetNodeIds = targetNodeIds.filter(
                      (nodeId) =>
                        (executionPlan.generatorIterationById.get(nodeId)
                          ?.iterations ?? 1) > laneIndex,
                    );
                    return laneTargetNodeIds.length
                      ? enqueueWorkflowExecutionJob(
                          {
                            request: {
                              ...submittedRequest,
                              executionLaneFilter: {
                                laneCount,
                                laneIndex,
                              },
                              selection: { nodeIds: laneTargetNodeIds },
                              target: { type: "selected-or-all" as const },
                            },
                            runId,
                            type: "execute-run",
                            userId,
                          },
                          {
                            jobId: createWorkflowExecutionLaneJobId({
                              laneIndex,
                              runId,
                            }),
                          },
                        )
                      : Promise.resolve(null);
                  }),
                );
                return;
              }

              await enqueueWorkflowExecutionJob({
                request: submittedRequest,
                runId,
                type: "execute-run",
                userId,
              });
            },
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
                    mergeExecutionLaneIndex: getRequestLaneIndex(request),
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
                const laneIndex = getRequestLaneIndex(request);
                if (laneIndex === null) {
                  yield* workflowRunStore
                    .updateRun({
                      ...state,
                      credits,
                    })
                    .pipe(Effect.orDie, Effect.asVoid);
                  return;
                }

                if (!hasLaneOutput(state, laneIndex)) {
                  return;
                }

                yield* workflowRunStore
                  .updateRunWith({
                    runId,
                    userId,
                    update: (currentRun) =>
                      Effect.try({
                        try: () => ({
                          result: null,
                          run:
                            currentRun.status === "waiting_for_review"
                              ? {
                                  ...mergeLaneScopedExecutionState({
                                    accruedCostCredits:
                                      currentRun.accruedCostCredits,
                                    currentRun,
                                    laneIndex,
                                    state,
                                  }),
                                  credits,
                                }
                              : currentRun.status === "queued" ||
                                  currentRun.status === "running"
                                ? {
                                    ...mergeLaneScopedExecutionState({
                                      accruedCostCredits:
                                        currentRun.accruedCostCredits,
                                      currentRun,
                                      laneIndex,
                                      state,
                                    }),
                                    credits,
                                    status: "running" as const,
                                  }
                                : currentRun,
                        }),
                        catch: toPersistenceError,
                      }),
                  })
                  .pipe(Effect.orDie, Effect.asVoid);
              }).pipe(Effect.orDie),
          },
        }).pipe(
          Effect.tap((state) =>
            Effect.gen(function* () {
              const executionLaneFilter = request.executionLaneFilter;
              if (state.status === "success" && executionLaneFilter) {
                return yield* workflowRunStore
                  .updateRunWith({
                    runId,
                    userId,
                    update: (currentRun) =>
                      Effect.gen(function* () {
                        if (
                          currentRun.status !== "queued" &&
                          currentRun.status !== "running"
                        ) {
                          return { result: null, run: currentRun };
                        }

                        const nextState = yield* Effect.try({
                          try: () =>
                            mergeLaneScopedExecutionState({
                              accruedCostCredits:
                                currentRun.accruedCostCredits +
                                getFilteredContinuationCostDelta(
                                  state,
                                  request,
                                ),
                              currentRun,
                              laneIndex: executionLaneFilter.laneIndex,
                              state,
                            }),
                          catch: toPersistenceError,
                        });
                        const isComplete = areExecutionLanesComplete(
                          nextState,
                          executionLaneFilter.laneCount,
                        );
                        const settledRun = isComplete
                          ? {
                              ...nextState,
                              finalCostCredits: nextState.accruedCostCredits,
                              runtime: {
                                ...nextState.runtime,
                                activity: "Workflow run finished.",
                                error: null,
                                finishedAt: new Date().toISOString(),
                              },
                              status: "success" as const,
                            }
                          : {
                              ...nextState,
                              finalCostCredits: null,
                              runtime: {
                                ...nextState.runtime,
                                activity: `Lane ${executionLaneFilter.laneIndex + 1} completed. Waiting for remaining lanes...`,
                                finishedAt: null,
                              },
                              status: "running" as const,
                            };
                        const documentRevision = yield* persistRunDocument(
                          settledRun,
                          userId,
                          executionLaneFilter.laneIndex,
                        );
                        const runWithRevision = withProjectDocumentRevision(
                          settledRun,
                          documentRevision,
                        );
                        const credits = isComplete
                          ? yield* settleRunCost({
                              reason: "Workflow execution settled.",
                              run: runWithRevision,
                              targetCost: runWithRevision.accruedCostCredits,
                              userId,
                            })
                          : yield* workflowCreditsService.getRunSummary({
                              runId,
                              userId,
                            });

                        return {
                          result: null,
                          run: {
                            ...runWithRevision,
                            credits,
                          },
                        };
                      }),
                  })
                  .pipe(Effect.map(({ run }) => run));
              }

              if (state.status === "success") {
                const credits = yield* settleRunCost({
                  reason: "Workflow execution settled.",
                  run: state,
                  targetCost: state.finalCostCredits ?? 0,
                  userId,
                });
                return yield* workflowRunStore.updateRun({
                  ...state,
                  credits,
                });
              }

              if (state.status === "waiting_for_review") {
                const executionLaneFilter = request.executionLaneFilter;
                if (executionLaneFilter) {
                  return yield* workflowRunStore
                    .updateRunWith({
                      runId,
                      userId,
                      update: (currentRun) =>
                        Effect.gen(function* () {
                          if (
                            currentRun.status !== "queued" &&
                            currentRun.status !== "running" &&
                            currentRun.status !== "waiting_for_review"
                          ) {
                            return {
                              result: null,
                              run: currentRun,
                            };
                          }

                          const nextState = yield* Effect.try({
                            try: () =>
                              mergeLaneScopedExecutionState({
                                accruedCostCredits:
                                  currentRun.accruedCostCredits +
                                  getFilteredContinuationCostDelta(
                                    state,
                                    request,
                                  ),
                                currentRun,
                                laneIndex: executionLaneFilter.laneIndex,
                                state,
                              }),
                            catch: toPersistenceError,
                          });
                          const isComplete = areExecutionLanesComplete(
                            nextState,
                            executionLaneFilter.laneCount,
                          );
                          const settledRun = isComplete
                            ? {
                                ...nextState,
                                finalCostCredits: null,
                                runtime: {
                                  ...nextState.runtime,
                                  activity: "Workflow is waiting for review.",
                                  error: null,
                                  finishedAt: null,
                                },
                                status: "waiting_for_review" as const,
                              }
                            : {
                                ...nextState,
                                finalCostCredits: null,
                                runtime: {
                                  ...nextState.runtime,
                                  activity: `Lane ${executionLaneFilter.laneIndex + 1} reached review. Waiting for remaining lanes...`,
                                  finishedAt: null,
                                },
                                status: "running" as const,
                              };
                          const documentRevision = yield* persistRunDocument(
                            settledRun,
                            userId,
                            executionLaneFilter.laneIndex,
                          );
                          const runWithRevision = withProjectDocumentRevision(
                            settledRun,
                            documentRevision,
                          );
                          const credits = isComplete
                            ? yield* settleRunCost({
                                reason:
                                  "Workflow execution paused for human review.",
                                run: runWithRevision,
                                userId,
                              })
                            : yield* workflowCreditsService.getRunSummary({
                                runId,
                                userId,
                              });

                          return {
                            result: null,
                            run: {
                              ...runWithRevision,
                              credits,
                            },
                          };
                        }),
                    })
                    .pipe(Effect.map(({ run }) => run));
                }

                const reviewLaneFilter = request.reviewLaneFilter;
                if (reviewLaneFilter) {
                  return yield* workflowRunStore
                    .updateRunWith({
                      runId,
                      userId,
                      update: (currentRun) =>
                        Effect.gen(function* () {
                          if (currentRun.status !== "waiting_for_review") {
                            return {
                              result: null,
                              run: currentRun,
                            };
                          }

                          const nextState = yield* Effect.try({
                            try: () =>
                              mergeLaneScopedExecutionState({
                                accruedCostCredits:
                                  currentRun.accruedCostCredits +
                                  getFilteredContinuationCostDelta(
                                    state,
                                    request,
                                  ),
                                currentRun,
                                laneIndex: reviewLaneFilter.laneIndex,
                                state,
                              }),
                            catch: toPersistenceError,
                          });
                          const credits = yield* settleRunCost({
                            reason:
                              "Workflow execution paused for human review.",
                            run: nextState,
                            userId,
                          });
                          const documentRevision = yield* persistRunDocument(
                            nextState,
                            userId,
                            reviewLaneFilter.laneIndex,
                          );

                          return {
                            result: null,
                            run: {
                              ...withProjectDocumentRevision(
                                nextState,
                                documentRevision,
                              ),
                              credits,
                            },
                          };
                        }),
                    })
                    .pipe(Effect.map(({ run }) => run));
                }

                const nextState = state;
                const credits = yield* settleRunCost({
                  reason: "Workflow execution paused for human review.",
                  run: nextState,
                  userId,
                });
                const documentRevision = yield* persistRunDocument(
                  nextState,
                  userId,
                );
                return yield* workflowRunStore.updateRun({
                  ...withProjectDocumentRevision(nextState, documentRevision),
                  credits,
                });
              }
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

              const settleFailureCost =
                request.reviewLaneFilter || request.executionLaneFilter
                  ? settleRunCost({
                      reason: getErrorMessage(error),
                      run: currentRun,
                      targetCost: currentRun.accruedCostCredits,
                      userId,
                    })
                  : workflowCreditsService.refundExecution({
                      executionId: runId,
                      reason: getErrorMessage(error),
                      userId,
                    });
              const credits = yield* settleFailureCost;
              const failureMessage = getErrorMessage(error);
              yield* workflowRunStore.updateRun({
                ...currentRun,
                activity:
                  request.executionLaneFilter || request.reviewLaneFilter
                    ? failureMessage
                    : currentRun.activity,
                credits,
                runtime:
                  request.executionLaneFilter || request.reviewLaneFilter
                    ? {
                        ...currentRun.runtime,
                        activity: failureMessage,
                        error: failureMessage,
                      }
                    : currentRun.runtime,
                status:
                  request.executionLaneFilter && currentRun.status === "queued"
                    ? "running"
                    : currentRun.status,
              });
              return yield* Effect.fail(error);
            }),
          ),
        );

      return WorkflowExecutionService.of({
        approveReviewLane,
        executeReviewLaneRegeneration,
        executeRun,
        failRun,
        rejectReviewLane,
        startRun,
      });
    }),
  );
}
