import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";
import {
  hydrateWorkflowGraphDocument,
  updateWorkflowDocumentNode,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import {
  getErrorMessage,
  WorkflowAuthorizationError,
  type WorkflowCreditsError,
  WorkflowInfrastructureError,
  type WorkflowRunNotFoundError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import {
  buildWorkflowApprovedRunProjection,
  buildWorkflowRunProjection,
  getWorkflowVisibleCompletionOutputs,
} from "~/lib/workflow/execution/artifact-projection";
import {
  estimateGeneratorReviewLaneRegenerationCreditCost,
  executeWorkflow,
  regenerateGeneratorReviewLane,
} from "~/lib/workflow/execution/core";
import {
  buildWorkflowLaneDependencyPlan,
  getReadyWorkflowLaneJobs,
  getWorkflowLaneKey,
} from "~/lib/workflow/execution/lane-dependencies";
import {
  buildWorkflowExecutionStatusResponse,
  createWorkflowExecutionRuntimeState,
} from "~/lib/workflow/execution/runtime-state";
import {
  buildWorkflowExecutionPlan,
  collectDownstreamWorkflowGeneratorNodeIds,
  extractWorkflowExecutionSubgraph,
} from "~/lib/workflow/execution/subgraph";
import { resolveWorkflowExecutionTargets } from "~/lib/workflow/execution/target-resolution";
import type {
  StartWorkflowExecutionRequest,
  WorkflowExecutionPortError,
  WorkflowExecutionRuntimeState,
  WorkflowExecutionStatusResponse,
  WorkflowRunArtifacts,
} from "~/lib/workflow/execution/types";
import { WorkflowLaneDependencyMissing } from "~/lib/workflow/execution/types";
import { estimateWorkflowExecution } from "~/lib/workflow/pricing";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";
import {
  buildLaneExecutionResultFromDocument,
  WorkflowArtifactStore,
} from "~/server/workflow/artifact-store";
import { WorkflowCreditsService } from "~/server/workflow/credits";
import {
  getWorkflowProject,
  saveWorkflowProjectExecutionResults,
} from "~/server/workflow/projects";
import {
  createWorkflowExecutionLaneJobId,
  createWorkflowReviewRegenerationJobId,
  enqueueWorkflowExecutionJob,
  enqueueWorkflowReviewRegenerationJob,
  getWorkflowExecutionQueue,
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
      attempt: number;
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
  static readonly Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const vertexAi = yield* VertexAi;
      const workflowCreditsService = yield* WorkflowCreditsService;
      const workflowArtifactStore = yield* WorkflowArtifactStore;
      const workflowRunStore = yield* WorkflowRunStore;

      const buildContinuationRequest = (
        run: WorkflowExecutionStatusResponse,
        userId: string,
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
          const artifacts = yield* workflowArtifactStore.getRunArtifacts({
            ownerUserId: userId,
            runId: run.runId,
          });
          const document = buildWorkflowApprovedRunProjection({
            artifacts,
            document: run.document,
          });

          return {
            ...context,
            accruedCostCredits: run.accruedCostCredits,
            document,
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

      const getCompletedLaneKeys = (artifacts: WorkflowRunArtifacts) =>
        new Set(
          getWorkflowVisibleCompletionOutputs(artifacts).map((output) =>
            getWorkflowLaneKey({
              laneIndex: output.laneIndex,
              nodeId: output.nodeId,
            }),
          ),
        );

      const getMaterializedLaneKeys = (artifacts: WorkflowRunArtifacts) =>
        new Set(
          artifacts.outputs.map((output) =>
            getWorkflowLaneKey({
              laneIndex: output.laneIndex,
              nodeId: output.nodeId,
            }),
          ),
        );

      const getBlockedLaneKeys = (params: {
        artifacts: WorkflowRunArtifacts;
        runId: string;
      }) =>
        Effect.tryPromise({
          try: async () => {
            const completedLanes = getCompletedLaneKeys(params.artifacts);
            const blockedLanes = new Set(
              Array.from(getMaterializedLaneKeys(params.artifacts)).filter(
                (key) => !completedLanes.has(key),
              ),
            );

            const queue = getWorkflowExecutionQueue();
            const jobs = await queue.getJobs([
              "active",
              "delayed",
              "prioritized",
              "waiting",
              "waiting-children",
            ]);
            for (const job of jobs) {
              const data = job.data;
              const laneFilter =
                data.type === "execute-run"
                  ? data.request.executionLaneFilter
                  : null;
              const nodeId =
                data.type === "execute-run"
                  ? data.request.selection?.nodeIds?.[0]
                  : null;
              if (data.runId === params.runId && laneFilter && nodeId) {
                blockedLanes.add(
                  getWorkflowLaneKey({
                    laneIndex: laneFilter.laneIndex,
                    nodeId,
                  }),
                );
              }
            }

            return blockedLanes;
          },
          catch: toPersistenceError,
        });

      const getReadyLaneJobs = (params: {
        artifacts: WorkflowRunArtifacts;
        blockedLanes?: ReadonlySet<string>;
        document: StartWorkflowExecutionRequest["document"];
        targetNodeIds: string[];
      }) => {
        const plan = buildWorkflowExecutionPlan(
          params.document,
          params.targetNodeIds,
        );
        return getReadyWorkflowLaneJobs({
          blockedLanes: params.blockedLanes,
          completedLanes: getCompletedLaneKeys(params.artifacts),
          plan: buildWorkflowLaneDependencyPlan({
            document: params.document,
            generatorIterationById: plan.generatorIterationById,
            targetNodeIds: params.targetNodeIds,
          }),
        });
      };

      const getSchedulableReadyLaneJobs = (params: {
        artifacts: WorkflowRunArtifacts;
        request: StartWorkflowExecutionRequest;
        runId: string;
        targetNodeIds: string[];
      }) =>
        Effect.gen(function* () {
          const blockedLanes = yield* getBlockedLaneKeys({
            artifacts: params.artifacts,
            runId: params.runId,
          });
          const readyJobs = getReadyLaneJobs({
            artifacts: params.artifacts,
            blockedLanes,
            document: params.request.document,
            targetNodeIds: params.targetNodeIds,
          });

          return readyJobs;
        });

      const enqueueLaneJobs = (params: {
        jobs: ReturnType<typeof getReadyWorkflowLaneJobs>;
        laneCount: number;
        request: StartWorkflowExecutionRequest;
        runId: string;
        userId: string;
      }) =>
        Effect.gen(function* () {
          if (!params.jobs.length) {
            return 0;
          }

          yield* Effect.tryPromise({
            try: async () => {
              // BullMQ job IDs are stable per {runId,nodeId,laneIndex}; combined
              // with blocked active jobs, duplicate lane scheduling is bounded.
              await Promise.all(
                params.jobs.map((job) =>
                  enqueueWorkflowExecutionJob(
                    {
                      request: {
                        ...params.request,
                        executionLaneFilter: {
                          laneCount: params.laneCount,
                          laneIndex: job.laneIndex,
                        },
                        reviewLaneFilter: null,
                        selection: { nodeIds: [job.nodeId] },
                        target: { type: "selected-or-all" as const },
                      },
                      runId: params.runId,
                      type: "execute-run",
                      userId: params.userId,
                    },
                    {
                      jobId: createWorkflowExecutionLaneJobId({
                        laneIndex: job.laneIndex,
                        nodeId: job.nodeId,
                        runId: params.runId,
                      }),
                    },
                  ),
                ),
              );
            },
            catch: toPersistenceError,
          });

          return params.jobs.length;
        });

      const enqueueReadyLaneJobs = (params: {
        artifacts: WorkflowRunArtifacts;
        laneCount: number;
        request: StartWorkflowExecutionRequest;
        runId: string;
        targetNodeIds: string[];
        userId: string;
      }) =>
        Effect.gen(function* () {
          const jobs = yield* getSchedulableReadyLaneJobs(params);
          return yield* enqueueLaneJobs({
            jobs,
            laneCount: params.laneCount,
            request: params.request,
            runId: params.runId,
            userId: params.userId,
          });
        });

      const isExecutionLaneComplete = (
        run: WorkflowExecutionStatusResponse,
        laneIndex: number,
        artifacts: WorkflowRunArtifacts,
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
        return expectedNodeIds.every((nodeId) =>
          artifacts.outputs.some(
            (output) =>
              output.nodeId === nodeId && output.laneIndex === laneIndex,
          ),
        );
      };

      const areExecutionLanesComplete = (
        run: WorkflowExecutionStatusResponse,
        laneCount: number,
        artifacts: WorkflowRunArtifacts,
      ) =>
        Array.from({ length: laneCount }, (_, laneIndex) => laneIndex).every(
          (laneIndex) => isExecutionLaneComplete(run, laneIndex, artifacts),
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

      const canDecideReviewLane = (run: WorkflowExecutionStatusResponse) =>
        run.status === "running" || run.status === "waiting_for_review";

      const getExpectedReviewLaneCount = (
        run: WorkflowExecutionStatusResponse,
        reviewNodeId: string,
        artifacts: WorkflowRunArtifacts,
      ) => {
        const reviewNode = run.document.nodes.find(
          (node) => node.id === reviewNodeId,
        );
        const plannedLaneCount =
          buildWorkflowExecutionPlan(
            run.document,
            run.targetNodeIds,
          ).generatorIterationById.get(reviewNodeId)?.iterations ?? 0;
        const artifactLaneCount = artifacts.reviewLanes
          .filter((lane) => lane.nodeId === reviewNodeId)
          .reduce((count, lane) => Math.max(count, lane.laneIndex + 1), 0);
        const projectedLaneCount =
          reviewNode &&
          (reviewNode.kind === "imageGenerator" ||
            reviewNode.kind === "videoGenerator" ||
            reviewNode.kind === "llmGenerator")
            ? Math.max(
                reviewNode.outputLanes.length,
                reviewNode.review.lanes.length,
              )
            : 0;

        return Math.max(
          plannedLaneCount,
          artifactLaneCount,
          projectedLaneCount,
        );
      };

      const getLatestReviewLaneArtifact = (
        artifacts: WorkflowRunArtifacts,
        params: { laneIndex: number; reviewNodeId: string },
      ) => {
        let latest: WorkflowRunArtifacts["reviewLanes"][number] | null = null;
        for (const lane of artifacts.reviewLanes) {
          if (
            lane.nodeId !== params.reviewNodeId ||
            lane.laneIndex !== params.laneIndex
          ) {
            continue;
          }
          if (!latest || latest.attempt < lane.attempt) {
            latest = lane;
          }
        }
        return latest;
      };

      const hasApprovedReviewLanes = (
        run: WorkflowExecutionStatusResponse,
        reviewNodeId: string,
        userId: string,
      ) =>
        workflowArtifactStore
          .getRunArtifacts({
            ownerUserId: userId,
            runId: run.runId,
          })
          .pipe(
            Effect.map((artifacts) => {
              const latestByLane = new Map(
                artifacts.reviewLanes
                  .filter((lane) => lane.nodeId === reviewNodeId)
                  .map((lane) => [lane.laneIndex, lane] as const),
              );
              for (const lane of artifacts.reviewLanes.filter(
                (lane) => lane.nodeId === reviewNodeId,
              )) {
                const existing = latestByLane.get(lane.laneIndex);
                if (!existing || existing.attempt < lane.attempt) {
                  latestByLane.set(lane.laneIndex, lane);
                }
              }
              const expectedLaneCount = getExpectedReviewLaneCount(
                run,
                reviewNodeId,
                artifacts,
              );
              return (
                expectedLaneCount > 0 &&
                Array.from({ length: expectedLaneCount }, (_, laneIndex) =>
                  latestByLane.get(laneIndex),
                ).every((lane) => lane?.status === "approved")
              );
            }),
          );

      const getReviewLaneForDecision = (params: {
        decision: "approve" | "regenerate";
        laneIndex: number;
        ownerUserId: string;
        reviewNodeId: string;
        run: WorkflowExecutionStatusResponse;
      }) =>
        Effect.gen(function* () {
          if (!canDecideReviewLane(params.run)) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Workflow run has no active human review.",
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
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Reviewed generator node not found.",
              }),
            );
          }

          const artifacts = yield* workflowArtifactStore.getRunArtifacts({
            ownerUserId: params.ownerUserId,
            runId: params.run.runId,
          });
          const lane = artifacts.reviewLanes
            .filter(
              (candidate) =>
                candidate.nodeId === params.reviewNodeId &&
                candidate.laneIndex === params.laneIndex,
            )
            .sort((left, right) => right.attempt - left.attempt)[0];

          if (!lane) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: `Review lane ${params.laneIndex + 1} does not exist.`,
              }),
            );
          }

          const projectedLane = reviewNode.review.lanes.find(
            (candidate) =>
              candidate.laneIndex === lane.laneIndex &&
              candidate.attempt === lane.attempt,
          );

          if (
            params.decision === "approve" &&
            lane.status !== "pending" &&
            lane.status !== "approved"
          ) {
            return yield* Effect.fail(
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
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: `Review lane ${params.laneIndex + 1} is not pending regeneration.`,
              }),
            );
          }

          return {
            lane: {
              assets: projectedLane?.assets ?? [],
              attempt: lane.attempt,
              laneIndex: lane.laneIndex,
              status: lane.status,
              text: projectedLane?.text ?? null,
            },
            reviewNode,
          };
        });

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
        documentRevision: number | null,
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

      const persistRunArtifacts = (
        run: WorkflowExecutionStatusResponse,
        userId: string,
        laneIndex?: number | null,
      ) =>
        Effect.gen(function* () {
          const projectId = run.requestContext?.projectId?.trim();
          if (!projectId) {
            return yield* Effect.fail(
              new WorkflowInfrastructureError({
                message: "Workflow project is missing from execution context.",
              }),
            );
          }

          yield* workflowArtifactStore.upsertLaneExecutionResult(
            buildLaneExecutionResultFromDocument({
              costCredits: run.accruedCostCredits,
              document: run.document,
              documentRevision:
                run.projectDocumentRevision ??
                run.requestContext?.documentRevision ??
                null,
              laneIndex: laneIndex ?? null,
              ownerUserId: userId,
              projectId,
              runId: run.runId,
              status: run.status === "queued" ? "running" : run.status,
              targetNodeIds: run.targetNodeIds,
            }),
          );

          const result = yield* Effect.tryPromise({
            try: () =>
              saveWorkflowProjectExecutionResults({
                document: run.document,
                ownerUserId: userId,
                projectId,
              }),
            catch: toPersistenceError,
          });

          return result.documentRevision;
        });

      const hydrateExecutionRequest = (
        runId: string,
        userId: string,
        request: StartWorkflowExecutionRequest,
      ) =>
        workflowArtifactStore
          .getRunArtifacts({ ownerUserId: userId, runId })
          .pipe(
            Effect.map((artifacts) => ({
              ...request,
              document: buildWorkflowRunProjection({
                artifacts,
                document: request.document,
              }),
            })),
          );

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
        document: mergeLaneScopedDocument({
          currentDocument: params.currentRun.document,
          laneIndex: params.laneIndex,
          stateDocument: params.state.document,
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
        runtime: mergeRuntimeState({
          currentRuntime: params.currentRun.runtime,
          stateRuntime: params.state.runtime,
        }),
        targetNodeIds: params.currentRun.targetNodeIds,
      });

      const mergeRuntimeState = (params: {
        currentRuntime: WorkflowExecutionRuntimeState;
        stateRuntime: WorkflowExecutionRuntimeState;
      }) => ({
        ...params.currentRuntime,
        activity: params.stateRuntime.activity,
        error: params.stateRuntime.error,
        finishedAt: params.stateRuntime.finishedAt,
        nodeStateById: {
          ...params.currentRuntime.nodeStateById,
          ...Object.fromEntries(
            Object.entries(params.stateRuntime.nodeStateById).filter(
              ([, nodeState]) =>
                nodeState.status !== "idle" || nodeState.error !== null,
            ),
          ),
        },
        startedAt:
          params.currentRuntime.startedAt ?? params.stateRuntime.startedAt,
      });

      const mergeLaneScopedDocument = (params: {
        currentDocument: WorkflowDocument;
        laneIndex: number;
        stateDocument: WorkflowDocument;
      }) => {
        const stateNodeById = new Map(
          params.stateDocument.nodes.map((node) => [node.id, node]),
        );

        return {
          ...params.currentDocument,
          nodes: params.currentDocument.nodes.map((currentNode) => {
            const stateNode = stateNodeById.get(currentNode.id);
            if (!stateNode || currentNode.kind !== stateNode.kind) {
              return currentNode;
            }

            if (
              currentNode.kind === "imageGenerator" &&
              stateNode.kind === "imageGenerator"
            ) {
              return {
                ...stateNode,
                outputLanes: mergeLaneValue(
                  currentNode.outputLanes,
                  stateNode.outputLanes,
                  params.laneIndex,
                ),
                review: mergeReviewLane(
                  currentNode.review,
                  stateNode.review,
                  params.laneIndex,
                ),
              };
            }

            if (
              currentNode.kind === "videoGenerator" &&
              stateNode.kind === "videoGenerator"
            ) {
              return {
                ...stateNode,
                outputLanes: mergeLaneValue(
                  currentNode.outputLanes,
                  stateNode.outputLanes,
                  params.laneIndex,
                ),
                review: mergeReviewLane(
                  currentNode.review,
                  stateNode.review,
                  params.laneIndex,
                ),
              };
            }

            if (
              currentNode.kind === "llmGenerator" &&
              stateNode.kind === "llmGenerator"
            ) {
              return {
                ...stateNode,
                outputLanes: mergeLaneValue(
                  currentNode.outputLanes,
                  stateNode.outputLanes,
                  params.laneIndex,
                ),
                review: mergeReviewLane(
                  currentNode.review,
                  stateNode.review,
                  params.laneIndex,
                ),
              };
            }

            return stateNode;
          }),
        } satisfies WorkflowDocument;
      };

      const mergeLaneValue = <Value>(
        currentValues: readonly Value[],
        stateValues: readonly Value[],
        laneIndex: number,
      ) => {
        if (!Object.hasOwn(stateValues, laneIndex)) {
          return [...currentValues];
        }

        const values = [...currentValues];
        values[laneIndex] = stateValues[laneIndex] as Value;
        return values;
      };

      const mergeReviewLane = <
        Review extends WorkflowDocument["nodes"][number],
      >(
        currentReview: Extract<Review, { review: unknown }>["review"],
        stateReview: Extract<Review, { review: unknown }>["review"],
        laneIndex: number,
      ) => {
        const stateLane = stateReview.lanes.find(
          (lane) => lane.laneIndex === laneIndex,
        );
        if (!stateLane) {
          return currentReview;
        }

        const lanes = currentReview.lanes.some(
          (lane) => lane.laneIndex === laneIndex,
        )
          ? currentReview.lanes.map((lane) =>
              lane.laneIndex === laneIndex ? stateLane : lane,
            )
          : [...currentReview.lanes, stateLane];

        return {
          ...currentReview,
          sourceNodeId: stateReview.sourceNodeId,
          updatedAt: stateReview.updatedAt ?? currentReview.updatedAt,
          valueType: stateReview.valueType,
          lanes: lanes.sort((left, right) => left.laneIndex - right.laneIndex),
        };
      };

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

          const artifacts = yield* workflowArtifactStore.getRunArtifacts({
            ownerUserId: userId,
            runId: run.runId,
          });

          return buildWorkflowRunProjection({
            artifacts,
            document: project.document,
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
            params.userId,
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
                const { lane } = yield* getReviewLaneForDecision({
                  decision: "approve",
                  laneIndex: params.laneIndex,
                  ownerUserId: params.userId,
                  reviewNodeId: params.reviewNodeId,
                  run: currentRun,
                });
                yield* workflowArtifactStore.setReviewLaneStatus({
                  attempt: lane.attempt,
                  laneIndex: params.laneIndex,
                  nodeId: params.reviewNodeId,
                  ownerUserId: params.userId,
                  runId: params.runId,
                  status: "approved",
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
                const isFullyApproved = yield* hasApprovedReviewLanes(
                  { ...currentRun, document },
                  params.reviewNodeId,
                  params.userId,
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
                        status: isFullyApproved ? "success" : "waiting",
                      },
                    },
                  },
                  status:
                    currentRun.status === "running"
                      ? ("running" as const)
                      : ("waiting_for_review" as const),
                } satisfies WorkflowExecutionStatusResponse;
                const documentRevision = yield* persistRunArtifacts(
                  nextRunBase,
                  params.userId,
                  params.laneIndex,
                );
                const persistedRunBase = withProjectDocumentRevision(
                  nextRunBase,
                  documentRevision,
                );
                const shouldResume = yield* hasApprovedReviewLanes(
                  persistedRunBase,
                  params.reviewNodeId,
                  params.userId,
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

            const request = yield* buildContinuationRequest(
              waitingRun,
              params.userId,
            );
            const artifacts = yield* workflowArtifactStore.getRunArtifacts({
              ownerUserId: params.userId,
              runId: params.runId,
            });
            const readyJobs = yield* getSchedulableReadyLaneJobs({
              artifacts,
              request,
              runId: params.runId,
              targetNodeIds: waitingRun.targetNodeIds,
            });
            if (!readyJobs.length) {
              const activity =
                "Human review approved. Waiting for dependent lanes...";
              return yield* workflowRunStore
                .updateRunWith({
                  runId: params.runId,
                  userId: params.userId,
                  update: (currentRun) =>
                    Effect.succeed({
                      result: null,
                      run: {
                        ...currentRun,
                        activity,
                        runtime: {
                          ...currentRun.runtime,
                          activity,
                        },
                        status: "running" as const,
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
            let schedulingFailureRun: WorkflowExecutionStatusResponse | null =
              null;
            const queuedLaneCount = yield* enqueueLaneJobs({
              jobs: readyJobs,
              laneCount: getExecutionLaneCount(
                request.document,
                waitingRun.targetNodeIds,
              ),
              request,
              runId: params.runId,
              userId: params.userId,
            }).pipe(
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
                  schedulingFailureRun = run;
                  return -1;
                }),
              ),
            );
            if (queuedLaneCount < 0) {
              return schedulingFailureRun ?? waitingRun;
            }

            const activity = queuedLaneCount
              ? "Human review approved. Resuming workflow..."
              : "Human review approved. Waiting for dependent lanes...";
            return yield* workflowRunStore
              .updateRunWith({
                runId: params.runId,
                userId: params.userId,
                update: (currentRun) =>
                  Effect.succeed({
                    result: null,
                    run: {
                      ...currentRun,
                      activity,
                      credits: reservedCredits,
                      runtime: {
                        ...currentRun.runtime,
                        activity,
                      },
                      status: queuedLaneCount
                        ? ("queued" as const)
                        : ("running" as const),
                    },
                  }),
              })
              .pipe(Effect.map(({ run }) => run));
          }

          if (!hasLaneContinuationTargets(waitingRun, params.reviewNodeId)) {
            return waitingRun;
          }

          const request = yield* buildContinuationRequest(
            waitingRun,
            params.userId,
            {
              laneIndex: params.laneIndex,
              reviewNodeId: params.reviewNodeId,
            },
          );
          const artifacts = yield* workflowArtifactStore.getRunArtifacts({
            ownerUserId: params.userId,
            runId: params.runId,
          });
          const readyJobs = yield* getSchedulableReadyLaneJobs({
            artifacts,
            request,
            runId: params.runId,
            targetNodeIds: waitingRun.targetNodeIds,
          });
          if (!readyJobs.length) {
            const activity = `Lane ${params.laneIndex + 1} approved. Waiting for dependent lanes...`;
            return yield* workflowRunStore
              .updateRunWith({
                runId: params.runId,
                userId: params.userId,
                update: (currentRun) =>
                  Effect.succeed({
                    result: null,
                    run: {
                      ...currentRun,
                      activity,
                      runtime: {
                        ...currentRun.runtime,
                        activity,
                      },
                      status:
                        currentRun.status === "running"
                          ? ("running" as const)
                          : ("waiting_for_review" as const),
                    },
                  }),
              })
              .pipe(Effect.map(({ run }) => run));
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

          let schedulingFailureRun: WorkflowExecutionStatusResponse | null =
            null;
          const queuedLaneCount = yield* enqueueLaneJobs({
            jobs: readyJobs,
            laneCount: getExecutionLaneCount(
              request.document,
              waitingRun.targetNodeIds,
            ),
            request,
            runId: params.runId,
            userId: params.userId,
          }).pipe(
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
                schedulingFailureRun = run;
                return -1;
              }),
            ),
          );
          if (queuedLaneCount < 0) {
            return schedulingFailureRun ?? waitingRun;
          }

          const activity = queuedLaneCount
            ? `Lane ${params.laneIndex + 1} approved. Queued ready workflow lanes.`
            : `Lane ${params.laneIndex + 1} approved. Waiting for dependent lanes...`;
          return yield* workflowRunStore
            .updateRunWith({
              runId: params.runId,
              userId: params.userId,
              update: (currentRun) =>
                Effect.succeed({
                  result: null,
                  run: {
                    ...currentRun,
                    activity,
                    credits: reservedCredits,
                    runtime: {
                      ...currentRun.runtime,
                      activity,
                    },
                    status: queuedLaneCount
                      ? ("queued" as const)
                      : currentRun.status === "running"
                        ? ("running" as const)
                        : ("waiting_for_review" as const),
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
          const {
            result: { nextAttempt, shouldQueueRegeneration },
            run: regeneratingRun,
          } = yield* workflowRunStore.updateRunWith({
            runId: params.runId,
            userId: params.userId,
            update: (currentRun) =>
              Effect.gen(function* () {
                const { lane } = yield* getReviewLaneForDecision({
                  decision: "regenerate",
                  laneIndex: params.laneIndex,
                  ownerUserId: params.userId,
                  reviewNodeId: params.reviewNodeId,
                  run: currentRun,
                });

                if (lane.status === "regenerating") {
                  return {
                    result: {
                      nextAttempt: lane.attempt + 1,
                      shouldQueueRegeneration: false,
                    },
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
                const nextAttempt =
                  yield* workflowArtifactStore.createNextAttempt({
                    laneIndex: params.laneIndex,
                    nodeId: params.reviewNodeId,
                    ownerUserId: params.userId,
                    runId: params.runId,
                  });

                const now = new Date().toISOString();
                const regeneratingDocument = updateWorkflowDocumentNode(
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
                                ? {
                                    ...lane,
                                    attempt: nextAttempt - 1,
                                    status: "regenerating",
                                  }
                                : lane,
                            ),
                            updatedAt: now,
                          },
                        }
                      : node,
                );

                return {
                  result: { nextAttempt, shouldQueueRegeneration: true },
                  run: {
                    ...currentRun,
                    credits: reservedCredits,
                    document: regeneratingDocument,
                    runtime: {
                      ...currentRun.runtime,
                      activity: `Regenerating lane ${params.laneIndex + 1} for review...`,
                    },
                    status:
                      currentRun.status === "running"
                        ? ("running" as const)
                        : ("waiting_for_review" as const),
                  },
                };
              }),
          });

          if (!shouldQueueRegeneration) {
            return regeneratingRun;
          }

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
                  attempt: nextAttempt,
                  laneIndex: params.laneIndex,
                  reviewNodeId: params.reviewNodeId,
                  runId: params.runId,
                  type: "regenerate-review-lane",
                  userId: params.userId,
                },
                {
                  jobId: createWorkflowReviewRegenerationJobId({
                    attempt: nextAttempt,
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
        attempt: number;
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
          const regenerationArtifacts =
            yield* workflowArtifactStore.getRunArtifacts({
              ownerUserId: params.userId,
              runId: params.runId,
            });
          const latestRegenerationLane = getLatestReviewLaneArtifact(
            regenerationArtifacts,
            {
              laneIndex: params.laneIndex,
              reviewNodeId: params.reviewNodeId,
            },
          );
          if (
            !latestRegenerationLane ||
            latestRegenerationLane.attempt >= params.attempt ||
            latestRegenerationLane.attempt !== params.attempt - 1 ||
            latestRegenerationLane.status !== "regenerating"
          ) {
            return regeneratingRun;
          }

          const regenerationDocument = yield* hydrateRunDocumentFromProject(
            regeneratingRun,
            params.userId,
          );
          const result = yield* regenerateGeneratorReviewLane({
            attempt: params.attempt,
            document: regenerationDocument,
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
              getNodeLaneOutput: (query) =>
                workflowArtifactStore.getNodeLaneOutput({
                  ...query,
                  ownerUserId: params.userId,
                }),
            },
            generatorNodeId: params.reviewNodeId,
            runId: params.runId,
          }).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                yield* workflowArtifactStore
                  .setReviewLaneStatus({
                    attempt: params.attempt - 1,
                    laneIndex: params.laneIndex,
                    nodeId: params.reviewNodeId,
                    ownerUserId: params.userId,
                    runId: params.runId,
                    status: "pending",
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
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
                  const currentArtifacts =
                    yield* workflowArtifactStore.getRunArtifacts({
                      ownerUserId: params.userId,
                      runId: params.runId,
                    });
                  const latestLane = getLatestReviewLaneArtifact(
                    currentArtifacts,
                    {
                      laneIndex: params.laneIndex,
                      reviewNodeId: params.reviewNodeId,
                    },
                  );
                  if (latestLane?.attempt !== params.attempt - 1) {
                    return { result: null, run: currentRun };
                  }
                  if (latestLane.status !== "regenerating") {
                    return { result: null, run: currentRun };
                  }

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
                    document: mergeLaneScopedDocument({
                      currentDocument: currentRun.document,
                      laneIndex: params.laneIndex,
                      stateDocument: result.document,
                    }),
                    runtime: {
                      ...currentRun.runtime,
                      activity: `Lane ${params.laneIndex + 1} regenerated. Review it again.`,
                    },
                    status:
                      currentRun.status === "running"
                        ? ("running" as const)
                        : ("waiting_for_review" as const),
                  } satisfies WorkflowExecutionStatusResponse;
                  const documentRevision = yield* persistRunArtifacts(
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

          const projectDocument = hydrateWorkflowGraphDocument(
            project.document,
          );
          if (!projectDocument) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Workflow project contains an invalid graph document.",
              }),
            );
          }

          const runId = randomUUID();
          const targetNodeIds = resolveWorkflowExecutionTargets(
            projectDocument,
            request.selection?.nodeIds ?? [],
            request.target,
          );

          WorkflowGraphValidator.validateExecutionTargets(
            projectDocument,
            targetNodeIds,
          );

          const submittedRequest = {
            ...request,
            documentRevision: project.documentRevision,
            document: extractWorkflowExecutionSubgraph(
              projectDocument,
              targetNodeIds,
            ),
            projectId,
          } satisfies StartWorkflowExecutionRequest;
          const executionPlan = buildWorkflowExecutionPlan(
            submittedRequest.document,
            targetNodeIds,
          );
          const executionNodeIds = executionPlan.executableNodeIds;
          const artifactNodeIds = Array.from(
            new Set([
              ...executionNodeIds,
              ...executionPlan.reviewBarrierNodeIds,
            ]),
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
            targetNodeIds: artifactNodeIds,
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

          const laneCount = getExecutionLaneCount(
            submittedRequest.document,
            targetNodeIds,
          );
          const shouldSplitLanes = laneCount > 1;

          yield* Effect.tryPromise({
            try: async () => {
              if (shouldSplitLanes) {
                const readyJobs = getReadyWorkflowLaneJobs({
                  completedLanes: new Set(),
                  plan: buildWorkflowLaneDependencyPlan({
                    document: submittedRequest.document,
                    generatorIterationById:
                      executionPlan.generatorIterationById,
                    targetNodeIds: artifactNodeIds,
                  }),
                });

                await Promise.all(
                  readyJobs.map((job) =>
                    enqueueWorkflowExecutionJob(
                      {
                        request: {
                          ...submittedRequest,
                          executionLaneFilter: {
                            laneCount,
                            laneIndex: job.laneIndex,
                          },
                          selection: { nodeIds: [job.nodeId] },
                          target: { type: "selected-or-all" as const },
                        },
                        runId,
                        type: "execute-run",
                        userId,
                      },
                      {
                        jobId: createWorkflowExecutionLaneJobId({
                          laneIndex: job.laneIndex,
                          nodeId: job.nodeId,
                          runId,
                        }),
                      },
                    ),
                  ),
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
        submittedRequest: StartWorkflowExecutionRequest,
      ) =>
        Effect.gen(function* () {
          const request = yield* hydrateExecutionRequest(
            runId,
            userId,
            submittedRequest,
          );

          return yield* executeWorkflow({
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
              getNodeLaneOutput: (query) =>
                workflowArtifactStore.getNodeLaneOutput({
                  ...query,
                  ownerUserId: userId,
                }),
              getNodeLaneValue: (query) =>
                workflowArtifactStore
                  .getRunArtifacts({ ownerUserId: userId, runId })
                  .pipe(
                    Effect.map((artifacts) => {
                      const document = buildWorkflowRunProjection({
                        artifacts,
                        document: request.document,
                      });
                      const node = document.nodes.find(
                        (candidate) => candidate.id === query.nodeId,
                      );

                      if (node?.kind === "llmGenerator") {
                        const text = node.outputLanes[query.laneIndex]?.trim();
                        return text ? { type: "text", lanes: [text] } : null;
                      }

                      if (
                        node?.kind === "imageGenerator" ||
                        node?.kind === "videoGenerator"
                      ) {
                        const assets = node.outputLanes[query.laneIndex] ?? [];
                        return assets.length
                          ? {
                              type:
                                node.kind === "imageGenerator"
                                  ? "image"
                                  : "video",
                              lanes: [assets],
                            }
                          : null;
                      }

                      return null;
                    }),
                  ),
              onCompleted: ({ document, finalCostCredits, targetNodeIds }) =>
                Effect.gen(function* () {
                  const run = buildWorkflowExecutionStatusResponse({
                    runId,
                    targetNodeIds,
                    accruedCostCredits: finalCostCredits,
                    projectDocumentRevision: request.documentRevision ?? null,
                    finalCostCredits,
                    document,
                    runtime: createWorkflowExecutionRuntimeState(
                      document,
                      "Workflow run finished.",
                    ),
                    requestContext: {
                      accruedCostCredits: finalCostCredits,
                      clientRunId: request.clientRunId ?? null,
                      documentRevision: request.documentRevision ?? null,
                      idempotencyKey: request.idempotencyKey ?? null,
                      projectId: request.projectId ?? null,
                      selection: request.selection ?? null,
                      target: request.target,
                    },
                    status: "success",
                  });

                  return yield* persistRunArtifacts(
                    run,
                    userId,
                    getRequestLaneIndex(request),
                  );
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
                    yield* workflowRunStore
                      .updateRunWith({
                        runId,
                        userId,
                        update: (currentRun) =>
                          Effect.succeed({
                            result: null,
                            run:
                              currentRun.status === "queued" ||
                              currentRun.status === "running" ||
                              currentRun.status === "waiting_for_review"
                                ? {
                                    ...currentRun,
                                    activity: state.runtime.activity,
                                    credits,
                                    runtime: mergeRuntimeState({
                                      currentRuntime: currentRun.runtime,
                                      stateRuntime: state.runtime,
                                    }),
                                    status:
                                      currentRun.status === "queued"
                                        ? ("running" as const)
                                        : currentRun.status,
                                  }
                                : currentRun,
                          }),
                      })
                      .pipe(Effect.orDie, Effect.asVoid);
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
                          yield* persistRunArtifacts(
                            nextState,
                            userId,
                            executionLaneFilter.laneIndex,
                          );
                          const artifacts =
                            yield* workflowArtifactStore.getRunArtifacts({
                              ownerUserId: userId,
                              runId,
                            });
                          const isComplete = areExecutionLanesComplete(
                            nextState,
                            executionLaneFilter.laneCount,
                            artifacts,
                          );
                          if (!isComplete) {
                            yield* enqueueReadyLaneJobs({
                              artifacts,
                              laneCount: executionLaneFilter.laneCount,
                              request,
                              runId,
                              targetNodeIds: currentRun.targetNodeIds,
                              userId,
                            });
                          }
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
                          const runWithRevision = withProjectDocumentRevision(
                            settledRun,
                            settledRun.projectDocumentRevision,
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

                if (state.status === "running" && executionLaneFilter) {
                  return yield* workflowRunStore
                    .updateRunWith({
                      runId,
                      userId,
                      update: (currentRun) =>
                        Effect.succeed({
                          result: null,
                          run:
                            currentRun.status === "queued" ||
                            currentRun.status === "running"
                              ? {
                                  ...currentRun,
                                  runtime: {
                                    ...currentRun.runtime,
                                    activity: state.runtime.activity,
                                    error: null,
                                    finishedAt: null,
                                  },
                                  status: "running" as const,
                                }
                              : currentRun,
                        }),
                    })
                    .pipe(Effect.map(({ run }) => run));
                }

                const reviewLaneFilter = request.reviewLaneFilter;
                if (state.status === "success" && reviewLaneFilter) {
                  return yield* workflowRunStore
                    .updateRunWith({
                      runId,
                      userId,
                      update: (currentRun) =>
                        Effect.gen(function* () {
                          if (
                            currentRun.status !== "queued" &&
                            !canDecideReviewLane(currentRun)
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
                                laneIndex: reviewLaneFilter.laneIndex,
                                state,
                              }),
                            catch: toPersistenceError,
                          });
                          const documentRevision = yield* persistRunArtifacts(
                            nextState,
                            userId,
                            reviewLaneFilter.laneIndex,
                          );
                          const credits =
                            yield* workflowCreditsService.getRunSummary({
                              runId,
                              userId,
                            });
                          const status =
                            currentRun.status === "queued"
                              ? ("queued" as const)
                              : currentRun.status === "running"
                                ? ("running" as const)
                                : ("waiting_for_review" as const);

                          return {
                            result: null,
                            run: {
                              ...withProjectDocumentRevision(
                                nextState,
                                documentRevision,
                              ),
                              credits,
                              finalCostCredits: null,
                              runtime: {
                                ...nextState.runtime,
                                activity:
                                  status === "queued"
                                    ? currentRun.runtime.activity
                                    : nextState.runtime.activity,
                                finishedAt: null,
                              },
                              status,
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
                            yield* persistRunArtifacts(
                              nextState,
                              userId,
                              executionLaneFilter.laneIndex,
                            );
                            const artifacts =
                              yield* workflowArtifactStore.getRunArtifacts({
                                ownerUserId: userId,
                                runId,
                              });
                            const isComplete = areExecutionLanesComplete(
                              nextState,
                              executionLaneFilter.laneCount,
                              artifacts,
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
                            const runWithRevision = withProjectDocumentRevision(
                              settledRun,
                              settledRun.projectDocumentRevision,
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

                  if (reviewLaneFilter) {
                    return yield* workflowRunStore
                      .updateRunWith({
                        runId,
                        userId,
                        update: (currentRun) =>
                          Effect.gen(function* () {
                            if (!canDecideReviewLane(currentRun)) {
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
                            const documentRevision = yield* persistRunArtifacts(
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
                                status:
                                  currentRun.status === "running"
                                    ? ("running" as const)
                                    : ("waiting_for_review" as const),
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
                  const documentRevision = yield* persistRunArtifacts(
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
                    error instanceof WorkflowLaneDependencyMissing
                      ? "error"
                      : request.executionLaneFilter &&
                          currentRun.status === "queued"
                        ? "running"
                        : currentRun.status,
                });
                return yield* Effect.fail(error);
              }),
            ),
          );
        });

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
