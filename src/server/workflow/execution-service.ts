import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
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
  type WorkflowExecutionNotFoundError,
  WorkflowInfrastructureError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import { getGeneratorOutputAttempt } from "~/lib/workflow/execution/artifact-identity";
import {
  buildWorkflowApprovedOutputProjection,
  buildWorkflowOutputProjection,
  getWorkflowVisibleCompletionOutputs,
} from "~/lib/workflow/execution/artifact-projection";
import {
  executeWorkflow,
  regenerateGeneratorReviewOutput,
} from "~/lib/workflow/execution/core";
import {
  buildWorkflowOutputDependencyPlan,
  getCompletedWorkflowOutputKeys,
  getReadyWorkflowOutputJobs,
  getWorkflowOutputKey,
  getWorkflowOutputSettlement,
} from "~/lib/workflow/execution/output-dependencies";
import {
  getGeneratorOutputValueType,
  selectReusableWorkflowOutputs,
} from "~/lib/workflow/execution/output-result-reuse";
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
  WorkflowOutputArtifacts,
} from "~/lib/workflow/execution/types";
import {
  getErroredWorkflowOutputResults,
  getLatestOutputReviewArtifacts,
  getLatestWorkflowOutputResults,
  WorkflowOutputDependencyMissing,
} from "~/lib/workflow/execution/types";
import {
  estimateWorkflowExecution,
  type WorkflowExecutionPriceQuote,
} from "~/lib/workflow/pricing";
import { getReviewOutputCount } from "~/lib/workflow/review-state";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";
import { db } from "~/server/db";
import { taskRuns } from "~/server/db/schema";
import {
  buildOutputExecutionResultFromDocument,
  WorkflowArtifactStore,
} from "~/server/workflow/artifact-store";
import { WorkflowCreditsService } from "~/server/workflow/credits";
import { WorkflowExecutionStore } from "~/server/workflow/execution-store";
import { WorkflowProjectStore } from "~/server/workflow/project-store";
import { enqueueQueuedWorkflowTasks } from "~/server/workflow/task-queue-scanner";
import {
  claimQueuedWorkflowTaskRun,
  createQueuedWorkflowTaskRuns,
  getTaskRunExecutionDocumentSnapshot,
  getTaskRunSnapshotOutputValue,
  toTaskRunExecutionRequest,
} from "~/server/workflow/task-run-store";
import { VertexAi } from "~/server/workflow/vertex";

export class WorkflowExecutionService extends Context.Tag(
  "WorkflowExecutionService",
)<
  WorkflowExecutionService,
  {
    readonly startExecution: (
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
    readonly quoteExecution: (
      userId: string,
      request: Pick<
        StartWorkflowExecutionRequest,
        "documentRevision" | "projectId" | "selection" | "target"
      >,
    ) => Effect.Effect<
      WorkflowExecutionPriceQuote,
      | WorkflowAuthorizationError
      | WorkflowInfrastructureError
      | WorkflowValidationError
    >;
    readonly approveReviewOutput: (params: {
      outputIndex: number;
      reviewNodeId: string;
      executionId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowExecutionPortError
      | WorkflowInfrastructureError
      | WorkflowExecutionNotFoundError
      | WorkflowValidationError
    >;
    readonly rejectReviewOutput: (params: {
      outputIndex: number;
      reviewNodeId: string;
      executionId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowExecutionPortError
      | WorkflowInfrastructureError
      | WorkflowExecutionNotFoundError
      | WorkflowValidationError
    >;
    readonly failExecution: (params: {
      message: string;
      executionId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowInfrastructureError
      | WorkflowExecutionNotFoundError
      | WorkflowValidationError
    >;
    readonly settleFailedExecutionOutput: (params: {
      outputIndex: number;
      message: string;
      nodeId: string;
      executionId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowInfrastructureError
      | WorkflowExecutionNotFoundError
      | WorkflowValidationError
    >;
    readonly settleFailedTaskRun: (params: {
      message: string;
      taskRunId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowInfrastructureError
      | WorkflowExecutionNotFoundError
      | WorkflowValidationError
    >;
    readonly executeTaskRun: (
      taskRunId: string,
      userId: string,
    ) => Effect.Effect<
      WorkflowExecutionStatusResponse | null,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowExecutionPortError
      | WorkflowInfrastructureError
      | WorkflowExecutionNotFoundError
      | WorkflowValidationError
    >;
  }
>() {
  static readonly Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const vertexAi = yield* VertexAi;
      const workflowCreditsService = yield* WorkflowCreditsService;
      const workflowArtifactStore = yield* WorkflowArtifactStore;
      const workflowStore = yield* WorkflowProjectStore;
      const workflowExecutionStore = yield* WorkflowExecutionStore;

      const buildContinuationRequest = (
        run: WorkflowExecutionStatusResponse,
        userId: string,
        reviewOutputFilter?: StartWorkflowExecutionRequest["reviewOutputFilter"],
      ) =>
        Effect.gen(function* () {
          const context = run.requestContext;
          if (!context) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "Workflow execution cannot be resumed without request context.",
              }),
            );
          }

          const downstreamTargetNodeIds = reviewOutputFilter
            ? collectDownstreamWorkflowGeneratorNodeIds(
                run.document,
                reviewOutputFilter.reviewNodeId,
                new Set(run.targetNodeIds),
              )
            : null;
          const projectId = context.projectId?.trim();
          const artifacts = projectId
            ? yield* workflowArtifactStore.getProjectArtifacts({
                ownerUserId: userId,
                projectId,
              })
            : yield* workflowArtifactStore.getOutputArtifacts({
                ownerUserId: userId,
                executionId: run.executionId,
              });
          const document = buildWorkflowApprovedOutputProjection({
            artifacts,
            document: run.document,
          });

          return {
            ...context,
            accruedCostCredits: run.accruedCostCredits,
            document,
            reviewOutputFilter: reviewOutputFilter ?? null,
            selection: downstreamTargetNodeIds
              ? { nodeIds: downstreamTargetNodeIds }
              : context.selection,
            target: downstreamTargetNodeIds
              ? { type: "selected-or-all" as const }
              : context.target,
          } satisfies StartWorkflowExecutionRequest;
        });

      const hasOutputContinuationTargets = (
        run: WorkflowExecutionStatusResponse,
        reviewNodeId: string,
      ) =>
        collectDownstreamWorkflowGeneratorNodeIds(
          run.document,
          reviewNodeId,
          new Set(run.targetNodeIds),
        ).length > 0;

      const getExecutionOutputCount = (
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

      const getExecutionDependencyPlan = (
        document: StartWorkflowExecutionRequest["document"],
        targetNodeIds: readonly string[],
      ) => {
        const plan = buildWorkflowExecutionPlan(document, [...targetNodeIds]);
        return buildWorkflowOutputDependencyPlan({
          document,
          generatorIterationById: plan.generatorIterationById,
          targetNodeIds,
        });
      };

      const getExecutionArtifactNodeIds = (
        document: StartWorkflowExecutionRequest["document"],
        targetNodeIds: readonly string[],
      ) => {
        const seedPlan = buildWorkflowExecutionPlan(document, [
          ...targetNodeIds,
        ]);
        const artifactNodeIds = new Set([
          ...seedPlan.executableNodeIds,
          ...seedPlan.reviewBarrierNodeIds,
        ]);
        let changed = true;

        while (changed) {
          changed = false;
          const dependencyPlan = getExecutionDependencyPlan(
            document,
            Array.from(artifactNodeIds),
          );
          for (const dependency of dependencyPlan.jobs.flatMap(
            (job) => job.dependencies,
          )) {
            if (!artifactNodeIds.has(dependency.nodeId)) {
              artifactNodeIds.add(dependency.nodeId);
              changed = true;
            }
          }
        }

        return Array.from(artifactNodeIds);
      };

      const getReusablePriorOutputs = (params: {
        document: StartWorkflowExecutionRequest["document"];
        excludeExecutionId?: string | null;
        ownerUserId: string;
        projectId: string;
        requestedTargetNodeIds: readonly string[];
        targetNodeIds: readonly string[];
      }) =>
        Effect.gen(function* () {
          const dependencyPlan = getExecutionDependencyPlan(
            params.document,
            params.targetNodeIds,
          );
          const plannedOutputs = Array.from(
            new Map(
              dependencyPlan.jobs
                .flatMap((job) => [job, ...job.dependencies])
                .map((output) => [getWorkflowOutputKey(output), output]),
            ).values(),
          );
          const nodeById = new Map(
            params.document.nodes.map((node) => [node.id, node]),
          );
          const requestedTargetNodeIds = new Set(params.requestedTargetNodeIds);
          const priorResultCandidates =
            yield* workflowArtifactStore.getProjectOutputReuseCandidates({
              excludeExecutionId: params.excludeExecutionId ?? null,
              items: plannedOutputs,
              ownerUserId: params.ownerUserId,
              projectId: params.projectId,
            });

          return selectReusableWorkflowOutputs({
            candidates: priorResultCandidates,
            expectedOutputs: plannedOutputs.flatMap((job) => {
              const valueType = getGeneratorOutputValueType(
                nodeById.get(job.nodeId),
              );
              const node = nodeById.get(job.nodeId);
              const reviewEnabled =
                node?.kind === "imageGenerator" ||
                node?.kind === "videoGenerator" ||
                node?.kind === "llmGenerator"
                  ? node.reviewEnabled
                  : false;
              return valueType
                ? [
                    {
                      ...job,
                      isRequestedTarget: requestedTargetNodeIds.has(job.nodeId),
                      reviewEnabled,
                      valueType,
                    },
                  ]
                : [];
            }),
          });
        });

      const quoteExecution = (
        userId: string,
        request: Pick<
          StartWorkflowExecutionRequest,
          "documentRevision" | "projectId" | "selection" | "target"
        >,
      ) =>
        Effect.gen(function* () {
          const projectId = request.projectId?.trim();
          if (!projectId) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "A workflow project is required to quote execution.",
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
                  "Workflow project must be saved before execution is quoted.",
              }),
            );
          }

          const project = yield* workflowStore.getProject({
            ownerUserId: userId,
            projectId,
          });

          if (project.documentRevision !== request.documentRevision) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "Workflow project changed before execution quote. Save again and retry.",
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

          const targetNodeIds = resolveWorkflowExecutionTargets(
            projectDocument,
            request.selection?.nodeIds ?? [],
            request.target,
          );
          WorkflowGraphValidator.validateExecutionTargets(
            projectDocument,
            targetNodeIds,
          );
          const document = extractWorkflowExecutionSubgraph(
            projectDocument,
            targetNodeIds,
          );
          const artifactNodeIds = getExecutionArtifactNodeIds(
            document,
            targetNodeIds,
          );
          const executionPlan = buildWorkflowExecutionPlan(
            document,
            artifactNodeIds,
          );
          const reusableOutputs = yield* getReusablePriorOutputs({
            document,
            ownerUserId: userId,
            projectId,
            requestedTargetNodeIds: targetNodeIds,
            targetNodeIds: artifactNodeIds,
          });

          return estimateWorkflowExecution(
            {
              ...request,
              document,
              documentRevision: project.documentRevision,
              projectId,
              selection: { nodeIds: executionPlan.executableNodeIds },
              target: { type: "selected-or-all" as const },
            },
            {
              completedOutputKeys: new Set(
                reusableOutputs.map(getWorkflowOutputKey),
              ),
            },
          );
        });

      const getMaterializedOutputKeys = (artifacts: WorkflowOutputArtifacts) =>
        new Set(
          getLatestWorkflowOutputResults(artifacts).map((result) =>
            getWorkflowOutputKey({
              outputIndex: result.outputIndex,
              nodeId: result.nodeId,
            }),
          ),
        );

      const getQueuedOutputKeys = (params: { executionId: string }) =>
        workflowArtifactStore
          .getActiveOutputKeys(params)
          .pipe(Effect.map((keys) => new Set(keys)));

      const getBlockedOutputKeys = (params: {
        artifacts: WorkflowOutputArtifacts;
        executionId: string;
      }) =>
        Effect.gen(function* () {
          const completedOutputs = getCompletedWorkflowOutputKeys(
            params.artifacts,
          );
          const blockedOutputs = new Set(
            Array.from(getMaterializedOutputKeys(params.artifacts)).filter(
              (key) => !completedOutputs.has(key),
            ),
          );
          for (const key of yield* getQueuedOutputKeys({
            executionId: params.executionId,
          })) {
            blockedOutputs.add(key);
          }

          return blockedOutputs;
        });

      const getReadyOutputJobs = (params: {
        artifacts: WorkflowOutputArtifacts;
        blockedOutputs?: ReadonlySet<string>;
        document: StartWorkflowExecutionRequest["document"];
        targetNodeIds: readonly string[];
      }) => {
        const settlement = getWorkflowOutputSettlement({
          artifacts: params.artifacts,
          blockedOutputs: params.blockedOutputs,
          plan: getExecutionDependencyPlan(
            params.document,
            params.targetNodeIds,
          ),
        });

        return getReadyWorkflowOutputJobs({
          blockedOutputs: settlement.blockedOutputs,
          completedOutputs: settlement.completedOutputs,
          plan: settlement.plan,
        });
      };

      const getSchedulableReadyOutputJobs = (params: {
        artifacts: WorkflowOutputArtifacts;
        request: StartWorkflowExecutionRequest;
        executionId: string;
        targetNodeIds: readonly string[];
      }) =>
        Effect.gen(function* () {
          const blockedOutputs = yield* getBlockedOutputKeys({
            artifacts: params.artifacts,
            executionId: params.executionId,
          });
          const readyJobs = getReadyOutputJobs({
            artifacts: params.artifacts,
            blockedOutputs,
            document: params.request.document,
            targetNodeIds: params.targetNodeIds,
          });

          return readyJobs;
        });

      const createQueuedTaskRows = (params: {
        artifacts: WorkflowOutputArtifacts;
        jobs: ReturnType<typeof getReadyWorkflowOutputJobs>;
        outputCount: number;
        request: StartWorkflowExecutionRequest;
        executionId: string;
        userId: string;
        versionOverride?: number | null;
      }) =>
        Effect.gen(function* () {
          const projectId = params.request.projectId?.trim();
          if (!projectId) {
            return yield* Effect.fail(
              new WorkflowInfrastructureError({
                message: "Workflow project is missing from execution context.",
              }),
            );
          }

          const taskRows = yield* createQueuedWorkflowTaskRuns({
            artifacts: params.artifacts,
            executionId: params.executionId,
            jobs: params.jobs,
            outputCount: params.outputCount,
            ownerUserId: params.userId,
            projectId,
            request: params.request,
            versionOverride: params.versionOverride,
          });
          if (taskRows.length) {
            yield* enqueueQueuedWorkflowTasks({
              taskRunIds: taskRows.map((row) => row.taskRunId),
            });
          }

          return taskRows.length;
        });

      const enqueueOutputJobs = createQueuedTaskRows;

      const enqueueReadyOutputJobs = (params: {
        artifacts: WorkflowOutputArtifacts;
        outputCount: number;
        request: StartWorkflowExecutionRequest;
        executionId: string;
        run?: WorkflowExecutionStatusResponse;
        targetNodeIds: string[];
        userId: string;
      }) =>
        Effect.gen(function* () {
          const jobs = yield* getSchedulableReadyOutputJobs(params);
          return yield* enqueueOutputJobs({
            artifacts: params.artifacts,
            jobs,
            outputCount: params.outputCount,
            request: params.request,
            executionId: params.executionId,
            userId: params.userId,
          });
        });

      const isExecutionOutputComplete = (
        run: WorkflowExecutionStatusResponse,
        outputIndex: number,
        artifacts: WorkflowOutputArtifacts,
      ) => {
        const plan = buildWorkflowExecutionPlan(
          run.document,
          run.targetNodeIds,
        );
        const expectedNodeIds = run.targetNodeIds.filter(
          (nodeId) =>
            (plan.generatorIterationById.get(nodeId)?.iterations ?? 1) >
            outputIndex,
        );
        const visibleOutputs = getWorkflowVisibleCompletionOutputs(artifacts);
        return expectedNodeIds.every((nodeId) =>
          visibleOutputs.some(
            (output) =>
              output.nodeId === nodeId && output.outputIndex === outputIndex,
          ),
        );
      };

      const areExecutionOutputsComplete = (
        run: WorkflowExecutionStatusResponse,
        outputCount: number,
        artifacts: WorkflowOutputArtifacts,
      ) =>
        Array.from(
          { length: outputCount },
          (_, outputIndex) => outputIndex,
        ).every((outputIndex) =>
          isExecutionOutputComplete(run, outputIndex, artifacts),
        );

      const hasOutput = (
        run: WorkflowExecutionStatusResponse,
        outputIndex: number,
      ) =>
        run.targetNodeIds.some((nodeId) => {
          const node = run.document.nodes.find(
            (candidate) => candidate.id === nodeId,
          );
          if (
            node?.kind === "imageGenerator" ||
            node?.kind === "videoGenerator"
          ) {
            return (node.outputs[outputIndex]?.length ?? 0) > 0;
          }
          if (node?.kind === "llmGenerator") {
            return Boolean(node.outputs[outputIndex]?.trim());
          }
          return false;
        });

      const canDecideReviewOutput = (run: WorkflowExecutionStatusResponse) =>
        run.status === "running" || run.status === "waiting_for_review";

      const getExpectedReviewOutputCount = (
        run: WorkflowExecutionStatusResponse,
        reviewNodeId: string,
        artifacts: WorkflowOutputArtifacts,
      ) => {
        const reviewNode = run.document.nodes.find(
          (node) => node.id === reviewNodeId,
        );
        const plannedOutputCount =
          buildWorkflowExecutionPlan(
            run.document,
            run.targetNodeIds,
          ).generatorIterationById.get(reviewNodeId)?.iterations ?? 0;
        const artifactOutputCount = getLatestOutputReviewArtifacts(artifacts)
          .filter((output) => output.nodeId === reviewNodeId)
          .reduce(
            (count, output) => Math.max(count, output.outputIndex + 1),
            0,
          );
        const projectedOutputCount =
          reviewNode &&
          (reviewNode.kind === "imageGenerator" ||
            reviewNode.kind === "videoGenerator" ||
            reviewNode.kind === "llmGenerator")
            ? Math.max(
                reviewNode.outputs.length,
                getReviewOutputCount(reviewNode),
              )
            : 0;

        return Math.max(
          plannedOutputCount,
          artifactOutputCount,
          projectedOutputCount,
        );
      };

      const getLatestOutputReviewArtifact = (
        artifacts: WorkflowOutputArtifacts,
        params: { outputIndex: number; reviewNodeId: string },
      ) => {
        let latest:
          | ReturnType<typeof getLatestOutputReviewArtifacts>[number]
          | null = null;
        for (const output of getLatestOutputReviewArtifacts(artifacts)) {
          if (
            output.nodeId !== params.reviewNodeId ||
            output.outputIndex !== params.outputIndex
          ) {
            continue;
          }
          if (!latest || latest.attempt < output.attempt) {
            latest = output;
          }
        }
        return latest;
      };

      const hasApprovedReviewOutputs = (
        run: WorkflowExecutionStatusResponse,
        reviewNodeId: string,
        userId: string,
      ) =>
        workflowArtifactStore
          .getOutputArtifacts({
            ownerUserId: userId,
            executionId: run.executionId,
          })
          .pipe(
            Effect.map((artifacts) => {
              const latestByOutput = new Map(
                getLatestOutputReviewArtifacts(artifacts)
                  .filter((output) => output.nodeId === reviewNodeId)
                  .map((output) => [output.outputIndex, output] as const),
              );
              for (const output of getLatestOutputReviewArtifacts(
                artifacts,
              ).filter((output) => output.nodeId === reviewNodeId)) {
                const existing = latestByOutput.get(output.outputIndex);
                if (!existing || existing.attempt < output.attempt) {
                  latestByOutput.set(output.outputIndex, output);
                }
              }
              const expectedOutputCount = getExpectedReviewOutputCount(
                run,
                reviewNodeId,
                artifacts,
              );
              return (
                expectedOutputCount > 0 &&
                Array.from({ length: expectedOutputCount }, (_, outputIndex) =>
                  latestByOutput.get(outputIndex),
                ).every((output) => output?.status === "approved")
              );
            }),
          );

      const getReviewOutputForDecision = (params: {
        decision: "approve" | "regenerate";
        outputIndex: number;
        ownerUserId: string;
        reviewNodeId: string;
        run: WorkflowExecutionStatusResponse;
      }) =>
        Effect.gen(function* () {
          if (!canDecideReviewOutput(params.run)) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Workflow execution has no active human review.",
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

          const artifacts = yield* workflowArtifactStore.getOutputArtifacts({
            ownerUserId: params.ownerUserId,
            executionId: params.run.executionId,
          });
          const output = getLatestOutputReviewArtifacts(artifacts)
            .filter(
              (candidate) =>
                candidate.nodeId === params.reviewNodeId &&
                candidate.outputIndex === params.outputIndex,
            )
            .sort((left, right) => right.attempt - left.attempt)[0];

          if (!output) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: `Review output ${params.outputIndex + 1} does not exist.`,
              }),
            );
          }

          const projectedOutput = reviewNode.review.outputs.find(
            (candidate) =>
              candidate.outputIndex === output.outputIndex &&
              candidate.attempt === output.attempt,
          );

          if (
            params.decision === "approve" &&
            output.status !== "pending" &&
            output.status !== "approved"
          ) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: `Review output ${params.outputIndex + 1} is not pending approval.`,
              }),
            );
          }

          if (
            params.decision === "regenerate" &&
            output.status !== "pending" &&
            output.status !== "regenerating"
          ) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: `Review output ${params.outputIndex + 1} is not pending regeneration.`,
              }),
            );
          }

          return {
            output: {
              assets: projectedOutput?.assets ?? [],
              attempt: output.attempt,
              outputIndex: output.outputIndex,
              status: output.status,
              text: projectedOutput?.text ?? null,
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

      const persistOutputArtifacts = (
        run: WorkflowExecutionStatusResponse,
        userId: string,
        outputIndex?: number | null,
        costCreditsByOutputKey?: ReadonlyMap<string, number>,
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

          yield* workflowArtifactStore.upsertOutputExecutionResult(
            buildOutputExecutionResultFromDocument({
              costCredits: run.accruedCostCredits,
              costCreditsByOutputKey,
              document: run.document,
              documentRevision:
                run.projectDocumentRevision ??
                run.requestContext?.documentRevision ??
                null,
              outputIndex: outputIndex ?? null,
              ownerUserId: userId,
              projectId,
              executionId: run.executionId,
              status: run.status === "queued" ? "running" : run.status,
              targetNodeIds: run.targetNodeIds,
            }),
          );

          return (
            run.projectDocumentRevision ??
            run.requestContext?.documentRevision ??
            null
          );
        });

      const getFilteredContinuationCostDelta = (
        state: WorkflowExecutionStatusResponse,
        request: StartWorkflowExecutionRequest,
      ) =>
        Math.max(
          0,
          state.accruedCostCredits - (request.accruedCostCredits ?? 0),
        );

      const mergeOutputScopedExecutionState = (params: {
        accruedCostCredits: number;
        currentExecution: WorkflowExecutionStatusResponse;
        outputIndex: number;
        state: WorkflowExecutionStatusResponse;
      }) => ({
        ...params.state,
        accruedCostCredits: params.accruedCostCredits,
        document: mergeOutputScopedDocument({
          currentDocument: params.currentExecution.document,
          outputIndex: params.outputIndex,
          stateDocument: params.state.document,
        }),
        projectDocumentRevision:
          params.currentExecution.projectDocumentRevision ??
          params.state.projectDocumentRevision,
        requestContext: params.state.requestContext
          ? {
              ...params.state.requestContext,
              accruedCostCredits: params.accruedCostCredits,
              documentRevision:
                params.currentExecution.requestContext?.documentRevision ??
                params.state.requestContext.documentRevision,
            }
          : null,
        runtime: mergeRuntimeState({
          currentRuntime: params.currentExecution.runtime,
          stateRuntime: params.state.runtime,
        }),
        targetNodeIds: params.currentExecution.targetNodeIds,
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
            Object.entries(params.stateRuntime.nodeStateById)
              .filter(
                ([, nodeState]) =>
                  nodeState.status !== "idle" || nodeState.error !== null,
              )
              .map(([nodeId, nodeState]) => {
                const currentNodeState =
                  params.currentRuntime.nodeStateById[nodeId];
                return [
                  nodeId,
                  currentNodeState?.status === "error"
                    ? currentNodeState
                    : nodeState,
                ];
              }),
          ),
        },
        startedAt:
          params.currentRuntime.startedAt ?? params.stateRuntime.startedAt,
      });

      const mergeOutputScopedDocument = (params: {
        currentDocument: WorkflowDocument;
        outputIndex: number;
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
                outputs: mergeOutputValue(
                  currentNode.outputs,
                  stateNode.outputs,
                  params.outputIndex,
                ),
                review: mergeReviewOutput(
                  currentNode.review,
                  stateNode.review,
                  params.outputIndex,
                ),
              };
            }

            if (
              currentNode.kind === "videoGenerator" &&
              stateNode.kind === "videoGenerator"
            ) {
              return {
                ...stateNode,
                outputs: mergeOutputValue(
                  currentNode.outputs,
                  stateNode.outputs,
                  params.outputIndex,
                ),
                review: mergeReviewOutput(
                  currentNode.review,
                  stateNode.review,
                  params.outputIndex,
                ),
              };
            }

            if (
              currentNode.kind === "llmGenerator" &&
              stateNode.kind === "llmGenerator"
            ) {
              return {
                ...stateNode,
                outputs: mergeOutputValue(
                  currentNode.outputs,
                  stateNode.outputs,
                  params.outputIndex,
                ),
                review: mergeReviewOutput(
                  currentNode.review,
                  stateNode.review,
                  params.outputIndex,
                ),
              };
            }

            return stateNode;
          }),
        } satisfies WorkflowDocument;
      };

      const mergeOutputValue = <Value>(
        currentValues: readonly Value[],
        stateValues: readonly Value[],
        outputIndex: number,
      ) => {
        if (!Object.hasOwn(stateValues, outputIndex)) {
          return [...currentValues];
        }

        const values = [...currentValues];
        values[outputIndex] = stateValues[outputIndex] as Value;
        return values;
      };

      const mergeReviewOutput = <
        Review extends WorkflowDocument["nodes"][number],
      >(
        currentReview: Extract<Review, { review: unknown }>["review"],
        stateReview: Extract<Review, { review: unknown }>["review"],
        outputIndex: number,
      ) => {
        const stateOutput = stateReview.outputs.find(
          (output) => output.outputIndex === outputIndex,
        );
        if (!stateOutput) {
          return currentReview;
        }

        const outputs = currentReview.outputs.some(
          (output) => output.outputIndex === outputIndex,
        )
          ? currentReview.outputs.map((output) =>
              output.outputIndex === outputIndex ? stateOutput : output,
            )
          : [...currentReview.outputs, stateOutput];

        return {
          ...currentReview,
          sourceNodeId: stateReview.sourceNodeId,
          updatedAt: stateReview.updatedAt ?? currentReview.updatedAt,
          valueType: stateReview.valueType,
          outputs: outputs.sort(
            (left, right) => left.outputIndex - right.outputIndex,
          ),
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

          const project = yield* workflowStore.getProject({
            ownerUserId: userId,
            projectId,
          });

          const artifacts = yield* workflowArtifactStore.getProjectArtifacts({
            ownerUserId: userId,
            projectId,
          });

          return buildWorkflowOutputProjection({
            artifacts,
            document: project.document,
          });
        });

      const getExecutionCredits = (params: {
        executionId: string;
        userId: string;
      }) => workflowCreditsService.getExecutionSummary(params);

      const chargeOutputCost = (params: {
        amount: number;
        attempt: number;
        executionId: string;
        idempotencyKey: string;
        inputHash: string;
        nodeId: string;
        outputIndex: number;
        projectId: string | null;
        taskRunId?: string | null;
        userId: string;
      }) => {
        const outputKey = `${params.projectId ?? ""}:${params.nodeId}:${params.outputIndex}`;
        return workflowCreditsService
          .debitExecutionOutput({
            amount: params.amount,
            executionId: params.executionId,
            reason: "Workflow output executed.",
            sourceKey: params.taskRunId
              ? ["workflow-task-run", params.taskRunId, params.nodeId].join(":")
              : [
                  "workflow-output",
                  params.executionId,
                  outputKey,
                  params.attempt,
                  params.idempotencyKey,
                  params.inputHash,
                ].join(":"),
            userId: params.userId,
          })
          .pipe(Effect.as({ amount: params.amount, outputKey }));
      };

      const getExecutionRequest = (run: WorkflowExecutionStatusResponse) =>
        run.requestContext
          ? ({
              ...run.requestContext,
              document: run.document,
              executionOutputFilter: null,
              reviewOutputFilter: null,
            } satisfies StartWorkflowExecutionRequest)
          : null;

      const getOutputFailureMessage = (artifacts: WorkflowOutputArtifacts) =>
        getErroredWorkflowOutputResults(artifacts)[0]?.error ??
        "Workflow execution failed.";

      const markRuntimeOutputFailed = (params: {
        message: string;
        nodeId: string;
        runtime: WorkflowExecutionRuntimeState;
      }): WorkflowExecutionRuntimeState => ({
        ...params.runtime,
        activity: params.message,
        error: params.message,
        nodeStateById: {
          ...params.runtime.nodeStateById,
          [params.nodeId]: {
            error: params.message,
            status: "error",
          },
        },
      });

      const areOutputJobsSettledByCompletionOrFailure = (params: {
        artifacts: WorkflowOutputArtifacts;
        run: WorkflowExecutionStatusResponse;
      }) => {
        const request = getExecutionRequest(params.run);
        return Boolean(
          request &&
            getErroredWorkflowOutputResults(params.artifacts).length &&
            getWorkflowOutputSettlement({
              artifacts: params.artifacts,
              plan: getExecutionDependencyPlan(
                request.document,
                params.run.targetNodeIds,
              ),
            }).settled,
        );
      };

      const settleFailedOutputRun = (params: {
        artifacts: WorkflowOutputArtifacts;
        credits: WorkflowExecutionStatusResponse["credits"];
        run: WorkflowExecutionStatusResponse;
      }) => {
        const message = getOutputFailureMessage(params.artifacts);
        return {
          ...params.run,
          activity: message,
          credits: params.credits,
          finalCostCredits: params.run.accruedCostCredits,
          runtime: {
            ...params.run.runtime,
            activity: message,
            error: message,
            finishedAt:
              params.run.runtime.finishedAt ?? new Date().toISOString(),
          },
          status: "error" as const,
        } satisfies WorkflowExecutionStatusResponse;
      };

      const getRequestOutputIndex = (request: StartWorkflowExecutionRequest) =>
        request.reviewOutputFilter?.outputIndex ??
        request.executionOutputFilter?.outputIndex ??
        null;

      const approveReviewOutput = (params: {
        outputIndex: number;
        reviewNodeId: string;
        executionId: string;
        userId: string;
      }) =>
        Effect.gen(function* () {
          const {
            result: { shouldResume },
            run: waitingRun,
          } = yield* workflowExecutionStore.updateExecutionWith({
            executionId: params.executionId,
            userId: params.userId,
            update: (currentExecution) =>
              Effect.gen(function* () {
                const { output } = yield* getReviewOutputForDecision({
                  decision: "approve",
                  outputIndex: params.outputIndex,
                  ownerUserId: params.userId,
                  reviewNodeId: params.reviewNodeId,
                  run: currentExecution,
                });
                yield* workflowArtifactStore.setReviewOutputStatus({
                  attempt: output.attempt,
                  outputIndex: params.outputIndex,
                  nodeId: params.reviewNodeId,
                  ownerUserId: params.userId,
                  executionId: params.executionId,
                  status: "approved",
                });

                const now = new Date().toISOString();
                const document = updateWorkflowDocumentNode(
                  currentExecution.document,
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
                        outputs: node.review.outputs.map((output) =>
                          output.outputIndex === params.outputIndex
                            ? { ...output, status: "approved" }
                            : output,
                        ),
                        updatedAt: now,
                      },
                    };
                  },
                );
                const isFullyApproved = yield* hasApprovedReviewOutputs(
                  { ...currentExecution, document },
                  params.reviewNodeId,
                  params.userId,
                );
                const nextRunBase = {
                  ...currentExecution,
                  activity: "Human review updated.",
                  document,
                  runtime: {
                    ...currentExecution.runtime,
                    activity: "Human review updated.",
                    nodeStateById: {
                      ...currentExecution.runtime.nodeStateById,
                      [params.reviewNodeId]: {
                        error: null,
                        status: isFullyApproved ? "success" : "waiting",
                      },
                    },
                  },
                  status:
                    currentExecution.status === "running"
                      ? ("running" as const)
                      : ("waiting_for_review" as const),
                } satisfies WorkflowExecutionStatusResponse;
                const documentRevision = yield* persistOutputArtifacts(
                  nextRunBase,
                  params.userId,
                  params.outputIndex,
                );
                const persistedRunBase = withProjectDocumentRevision(
                  nextRunBase,
                  documentRevision,
                );
                const shouldResume = yield* hasApprovedReviewOutputs(
                  persistedRunBase,
                  params.reviewNodeId,
                  params.userId,
                );
                const activity = shouldResume
                  ? "Human review approved. Queueing workflow resume..."
                  : `Output ${params.outputIndex + 1} approved. Continuing that output...`;

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
            if (
              !hasOutputContinuationTargets(waitingRun, params.reviewNodeId)
            ) {
              const credits = yield* getExecutionCredits({
                executionId: waitingRun.executionId,
                userId: params.userId,
              });

              return yield* workflowExecutionStore
                .updateExecutionWith({
                  executionId: params.executionId,
                  userId: params.userId,
                  update: (currentExecution) =>
                    Effect.succeed({
                      result: null,
                      run: {
                        ...currentExecution,
                        activity: "Workflow execution finished.",
                        credits,
                        finalCostCredits: currentExecution.accruedCostCredits,
                        runtime: {
                          ...currentExecution.runtime,
                          activity: "Workflow execution finished.",
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
            const artifacts = yield* workflowArtifactStore.getOutputArtifacts({
              ownerUserId: params.userId,
              executionId: params.executionId,
            });
            const readyJobs = yield* getSchedulableReadyOutputJobs({
              artifacts,
              request,
              executionId: params.executionId,
              targetNodeIds: waitingRun.targetNodeIds,
            });
            if (!readyJobs.length) {
              const activity =
                "Human review approved. Waiting for dependent outputs...";
              return yield* workflowExecutionStore
                .updateExecutionWith({
                  executionId: params.executionId,
                  userId: params.userId,
                  update: (currentExecution) =>
                    Effect.succeed({
                      result: null,
                      run: {
                        ...currentExecution,
                        activity,
                        runtime: {
                          ...currentExecution.runtime,
                          activity,
                        },
                        status: "running" as const,
                      },
                    }),
                })
                .pipe(Effect.map(({ run }) => run));
            }

            const currentCredits = yield* getExecutionCredits({
              executionId: params.executionId,
              userId: params.userId,
            });
            let schedulingFailureRun: WorkflowExecutionStatusResponse | null =
              null;
            const queuedOutputCount = yield* enqueueOutputJobs({
              artifacts,
              jobs: readyJobs,
              outputCount: getExecutionOutputCount(
                request.document,
                waitingRun.targetNodeIds,
              ),
              request,
              executionId: params.executionId,
              userId: params.userId,
            }).pipe(
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  const credits = yield* getExecutionCredits({
                    executionId: params.executionId,
                    userId: params.userId,
                  }).pipe(
                    Effect.catchAll(() => Effect.succeed(currentCredits)),
                  );
                  const { run } =
                    yield* workflowExecutionStore.updateExecutionWith({
                      executionId: params.executionId,
                      userId: params.userId,
                      update: (currentExecution) =>
                        Effect.succeed({
                          result: null,
                          run: {
                            ...currentExecution,
                            activity: getErrorMessage(error),
                            credits,
                            runtime: {
                              ...currentExecution.runtime,
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
            if (queuedOutputCount < 0) {
              return schedulingFailureRun ?? waitingRun;
            }

            const activity = queuedOutputCount
              ? "Human review approved. Resuming workflow..."
              : "Human review approved. Waiting for dependent outputs...";
            return yield* workflowExecutionStore
              .updateExecutionWith({
                executionId: params.executionId,
                userId: params.userId,
                update: (currentExecution) =>
                  Effect.succeed({
                    result: null,
                    run: {
                      ...currentExecution,
                      activity,
                      credits: currentCredits,
                      runtime: {
                        ...currentExecution.runtime,
                        activity,
                      },
                      status: queuedOutputCount
                        ? ("queued" as const)
                        : ("running" as const),
                    },
                  }),
              })
              .pipe(Effect.map(({ run }) => run));
          }

          if (!hasOutputContinuationTargets(waitingRun, params.reviewNodeId)) {
            return waitingRun;
          }

          const request = yield* buildContinuationRequest(
            waitingRun,
            params.userId,
            {
              outputIndex: params.outputIndex,
              reviewNodeId: params.reviewNodeId,
            },
          );
          const artifacts = yield* workflowArtifactStore.getOutputArtifacts({
            ownerUserId: params.userId,
            executionId: params.executionId,
          });
          const readyJobs = yield* getSchedulableReadyOutputJobs({
            artifacts,
            request,
            executionId: params.executionId,
            targetNodeIds: waitingRun.targetNodeIds,
          });
          if (!readyJobs.length) {
            const activity = `Output ${params.outputIndex + 1} approved. Waiting for dependent outputs...`;
            return yield* workflowExecutionStore
              .updateExecutionWith({
                executionId: params.executionId,
                userId: params.userId,
                update: (currentExecution) =>
                  Effect.succeed({
                    result: null,
                    run: {
                      ...currentExecution,
                      activity,
                      runtime: {
                        ...currentExecution.runtime,
                        activity,
                      },
                      status:
                        currentExecution.status === "running"
                          ? ("running" as const)
                          : ("waiting_for_review" as const),
                    },
                  }),
              })
              .pipe(Effect.map(({ run }) => run));
          }

          const currentCredits = yield* getExecutionCredits({
            executionId: params.executionId,
            userId: params.userId,
          });

          let schedulingFailureRun: WorkflowExecutionStatusResponse | null =
            null;
          const queuedOutputCount = yield* enqueueOutputJobs({
            artifacts,
            jobs: readyJobs,
            outputCount: getExecutionOutputCount(
              request.document,
              waitingRun.targetNodeIds,
            ),
            request,
            executionId: params.executionId,
            userId: params.userId,
          }).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                const credits = yield* getExecutionCredits({
                  executionId: params.executionId,
                  userId: params.userId,
                }).pipe(Effect.catchAll(() => Effect.succeed(currentCredits)));
                const { run } =
                  yield* workflowExecutionStore.updateExecutionWith({
                    executionId: params.executionId,
                    userId: params.userId,
                    update: (currentExecution) =>
                      Effect.succeed({
                        result: null,
                        run: {
                          ...currentExecution,
                          activity: getErrorMessage(error),
                          credits,
                          runtime: {
                            ...currentExecution.runtime,
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
          if (queuedOutputCount < 0) {
            return schedulingFailureRun ?? waitingRun;
          }

          const activity = queuedOutputCount
            ? `Output ${params.outputIndex + 1} approved. Queued ready workflow outputs.`
            : `Output ${params.outputIndex + 1} approved. Waiting for dependent outputs...`;
          return yield* workflowExecutionStore
            .updateExecutionWith({
              executionId: params.executionId,
              userId: params.userId,
              update: (currentExecution) =>
                Effect.succeed({
                  result: null,
                  run: {
                    ...currentExecution,
                    activity,
                    credits: currentCredits,
                    runtime: {
                      ...currentExecution.runtime,
                      activity,
                    },
                    status: queuedOutputCount
                      ? ("queued" as const)
                      : currentExecution.status === "running"
                        ? ("running" as const)
                        : ("waiting_for_review" as const),
                  },
                }),
            })
            .pipe(Effect.map(({ run }) => run));
        });

      const rejectReviewOutput = (params: {
        outputIndex: number;
        reviewNodeId: string;
        executionId: string;
        userId: string;
      }) =>
        Effect.gen(function* () {
          const {
            result: { nextAttempt, shouldQueueRegeneration },
            run: regeneratingExecution,
          } = yield* workflowExecutionStore.updateExecutionWith({
            executionId: params.executionId,
            userId: params.userId,
            update: (currentExecution) =>
              Effect.gen(function* () {
                const { output } = yield* getReviewOutputForDecision({
                  decision: "regenerate",
                  outputIndex: params.outputIndex,
                  ownerUserId: params.userId,
                  reviewNodeId: params.reviewNodeId,
                  run: currentExecution,
                });

                if (output.status === "regenerating") {
                  return {
                    result: {
                      nextAttempt: output.attempt + 1,
                      shouldQueueRegeneration: false,
                    },
                    run: currentExecution,
                  };
                }

                const credits = yield* getExecutionCredits({
                  executionId: params.executionId,
                  userId: params.userId,
                });
                const nextAttempt =
                  yield* workflowArtifactStore.createNextAttempt({
                    outputIndex: params.outputIndex,
                    nodeId: params.reviewNodeId,
                    ownerUserId: params.userId,
                    executionId: params.executionId,
                  });

                const now = new Date().toISOString();
                const regeneratingDocument = updateWorkflowDocumentNode(
                  currentExecution.document,
                  params.reviewNodeId,
                  (node) =>
                    node.kind === "imageGenerator" ||
                    node.kind === "videoGenerator" ||
                    node.kind === "llmGenerator"
                      ? {
                          ...node,
                          review: {
                            ...node.review,
                            outputs: node.review.outputs.map((output) =>
                              output.outputIndex === params.outputIndex
                                ? {
                                    ...output,
                                    attempt: nextAttempt,
                                    status: "regenerating",
                                  }
                                : output,
                            ),
                            updatedAt: now,
                          },
                        }
                      : node,
                );

                return {
                  result: { nextAttempt, shouldQueueRegeneration: true },
                  run: {
                    ...currentExecution,
                    credits,
                    document: regeneratingDocument,
                    runtime: {
                      ...currentExecution.runtime,
                      activity: `Regenerating output ${params.outputIndex + 1} for review...`,
                    },
                    status:
                      currentExecution.status === "running"
                        ? ("running" as const)
                        : ("waiting_for_review" as const),
                  },
                };
              }),
          });

          if (!shouldQueueRegeneration) {
            return regeneratingExecution;
          }

          const artifacts = yield* workflowArtifactStore.getOutputArtifacts({
            ownerUserId: params.userId,
            executionId: params.executionId,
          });
          const plan = getExecutionDependencyPlan(
            regeneratingExecution.document,
            [params.reviewNodeId],
          );
          const job = plan.jobs.find(
            (candidate) =>
              candidate.nodeId === params.reviewNodeId &&
              candidate.outputIndex === params.outputIndex,
          );
          if (!job) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Review regeneration output is not executable.",
              }),
            );
          }
          const projectId =
            regeneratingExecution.requestContext?.projectId?.trim();
          if (!projectId) {
            return yield* Effect.fail(
              new WorkflowInfrastructureError({
                message: "Workflow project is missing from execution context.",
              }),
            );
          }
          const outputCount = getExecutionOutputCount(
            regeneratingExecution.document,
            [params.reviewNodeId],
          );
          yield* enqueueOutputJobs({
            artifacts,
            jobs: [job],
            outputCount,
            request: {
              ...(regeneratingExecution.requestContext ?? {}),
              document: regeneratingExecution.document,
              documentRevision:
                regeneratingExecution.requestContext?.documentRevision ?? null,
              executionOutputFilter: null,
              projectId,
              reviewOutputFilter: null,
              selection: { nodeIds: [params.reviewNodeId] },
              target: { type: "selected-or-all" },
            },
            executionId: params.executionId,
            userId: params.userId,
            versionOverride: nextAttempt,
          });

          return regeneratingExecution;
        });

      const _executeReviewOutputRegeneration = (params: {
        attempt: number;
        outputIndex: number;
        reviewNodeId: string;
        executionId: string;
        userId: string;
      }) =>
        Effect.gen(function* () {
          const regeneratingExecution =
            yield* workflowExecutionStore.getExecution({
              executionId: params.executionId,
              userId: params.userId,
            });
          const regenerationArtifacts =
            yield* workflowArtifactStore.getOutputArtifacts({
              ownerUserId: params.userId,
              executionId: params.executionId,
            });
          const latestRegenerationOutput = getLatestOutputReviewArtifact(
            regenerationArtifacts,
            {
              outputIndex: params.outputIndex,
              reviewNodeId: params.reviewNodeId,
            },
          );
          if (
            !latestRegenerationOutput ||
            latestRegenerationOutput.attempt >= params.attempt ||
            latestRegenerationOutput.attempt !== params.attempt - 1 ||
            latestRegenerationOutput.status !== "regenerating"
          ) {
            return regeneratingExecution;
          }

          const regenerationDocument = yield* hydrateRunDocumentFromProject(
            regeneratingExecution,
            params.userId,
          );
          const projectId =
            regeneratingExecution.requestContext?.projectId?.trim();
          if (!projectId) {
            return yield* Effect.fail(
              new WorkflowInfrastructureError({
                message: "Workflow project is missing from execution context.",
              }),
            );
          }
          const chargedOutputCosts = new Map<string, number>();
          const result = yield* regenerateGeneratorReviewOutput({
            attempt: params.attempt,
            document: regenerationDocument,
            outputIndex: params.outputIndex,
            ports: {
              generateImage: (imageRequest) =>
                vertexAi.generateImagesWithNanoBananaPro({
                  ownerUserId: params.userId,
                  projectId,
                  request: imageRequest,
                }),
              generateLlm: (llmRequest) =>
                vertexAi.generateTextWithGemini3Flash({
                  ownerUserId: params.userId,
                  projectId,
                  request: llmRequest,
                }),
              generateVideo: (videoRequest) =>
                vertexAi.generateVideosWithVeo31({
                  ownerUserId: params.userId,
                  projectId,
                  request: videoRequest,
                }),
              getNodeOutput: () => Effect.succeed(null),
              onOutputCost: (cost) =>
                chargeOutputCost({
                  ...cost,
                  executionId: params.executionId,
                  projectId:
                    regeneratingExecution.requestContext?.projectId ?? null,
                  userId: params.userId,
                }).pipe(
                  Effect.map(({ amount, outputKey }) => {
                    chargedOutputCosts.set(outputKey, amount);
                    return amount;
                  }),
                ),
            },
            generatorNodeId: params.reviewNodeId,
            executionId: params.executionId,
          }).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                yield* workflowArtifactStore
                  .setReviewOutputStatus({
                    attempt: params.attempt - 1,
                    outputIndex: params.outputIndex,
                    nodeId: params.reviewNodeId,
                    ownerUserId: params.userId,
                    projectId:
                      regeneratingExecution.requestContext?.projectId ?? null,
                    executionId: params.executionId,
                    status: "pending",
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
                yield* workflowExecutionStore.updateExecutionWith({
                  executionId: params.executionId,
                  userId: params.userId,
                  update: (currentExecution) =>
                    Effect.gen(function* () {
                      const credits = yield* getExecutionCredits({
                        executionId: params.executionId,
                        userId: params.userId,
                      }).pipe(
                        Effect.catchAll(() =>
                          Effect.succeed(currentExecution.credits),
                        ),
                      );

                      return {
                        result: null,
                        run: {
                          ...currentExecution,
                          credits,
                          document: updateWorkflowDocumentNode(
                            currentExecution.document,
                            params.reviewNodeId,
                            (node) =>
                              node.kind === "imageGenerator" ||
                              node.kind === "videoGenerator" ||
                              node.kind === "llmGenerator"
                                ? {
                                    ...node,
                                    review: {
                                      ...node.review,
                                      outputs: node.review.outputs.map(
                                        (output) =>
                                          output.outputIndex ===
                                          params.outputIndex
                                            ? { ...output, status: "pending" }
                                            : output,
                                      ),
                                      updatedAt: new Date().toISOString(),
                                    },
                                  }
                                : node,
                          ),
                          runtime: {
                            ...currentExecution.runtime,
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

          return yield* workflowExecutionStore
            .updateExecutionWith({
              executionId: params.executionId,
              userId: params.userId,
              update: (currentExecution) =>
                Effect.gen(function* () {
                  const currentArtifacts =
                    yield* workflowArtifactStore.getOutputArtifacts({
                      ownerUserId: params.userId,
                      executionId: params.executionId,
                    });
                  const latestOutput = getLatestOutputReviewArtifact(
                    currentArtifacts,
                    {
                      outputIndex: params.outputIndex,
                      reviewNodeId: params.reviewNodeId,
                    },
                  );
                  if (latestOutput?.attempt !== params.attempt - 1) {
                    return { result: null, run: currentExecution };
                  }
                  if (latestOutput.status !== "regenerating") {
                    return { result: null, run: currentExecution };
                  }

                  const nextAccruedCostCredits =
                    currentExecution.accruedCostCredits + result.costCredits;
                  const credits = yield* getExecutionCredits({
                    executionId: params.executionId,
                    userId: params.userId,
                  });
                  const nextRunBase = {
                    ...currentExecution,
                    accruedCostCredits: nextAccruedCostCredits,
                    credits,
                    document: mergeOutputScopedDocument({
                      currentDocument: currentExecution.document,
                      outputIndex: params.outputIndex,
                      stateDocument: result.document,
                    }),
                    runtime: {
                      ...currentExecution.runtime,
                      activity: `Output ${params.outputIndex + 1} regenerated. Review it again.`,
                    },
                    status:
                      currentExecution.status === "running"
                        ? ("running" as const)
                        : ("waiting_for_review" as const),
                  } satisfies WorkflowExecutionStatusResponse;
                  const documentRevision = yield* persistOutputArtifacts(
                    nextRunBase,
                    params.userId,
                    params.outputIndex,
                    chargedOutputCosts,
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

      const failExecution = (params: {
        message: string;
        executionId: string;
        userId: string;
      }) =>
        Effect.gen(function* () {
          const currentExecution = yield* workflowExecutionStore.getExecution({
            executionId: params.executionId,
            userId: params.userId,
          });

          if (
            currentExecution.status === "error" ||
            currentExecution.status === "success"
          ) {
            return currentExecution;
          }

          const credits = yield* getExecutionCredits({
            executionId: params.executionId,
            userId: params.userId,
          });

          return yield* workflowExecutionStore.updateExecution({
            ...currentExecution,
            activity: params.message,
            credits,
            runtime: {
              ...currentExecution.runtime,
              activity: params.message,
              error: params.message,
              finishedAt:
                currentExecution.runtime.finishedAt ?? new Date().toISOString(),
            },
            status:
              currentExecution.status === "waiting_for_review"
                ? "waiting_for_review"
                : "error",
          });
        });

      const settleFailedExecutionOutput = (params: {
        outputIndex: number;
        message: string;
        nodeId: string;
        executionId: string;
        userId: string;
      }) =>
        workflowExecutionStore
          .updateExecutionWith({
            executionId: params.executionId,
            userId: params.userId,
            update: (currentExecution) =>
              Effect.gen(function* () {
                if (
                  currentExecution.status !== "queued" &&
                  currentExecution.status !== "running"
                ) {
                  return { result: null, run: currentExecution };
                }

                const projectId =
                  currentExecution.requestContext?.projectId?.trim();
                if (!projectId) {
                  return yield* Effect.fail(
                    new WorkflowInfrastructureError({
                      message:
                        "Workflow project is missing from execution context.",
                    }),
                  );
                }

                const node = currentExecution.document.nodes.find(
                  (candidate) => candidate.id === params.nodeId,
                );
                if (
                  !node ||
                  (node.kind !== "imageGenerator" &&
                    node.kind !== "videoGenerator" &&
                    node.kind !== "llmGenerator")
                ) {
                  return yield* Effect.fail(
                    new WorkflowInfrastructureError({
                      message: `Workflow output failure references non-generator node ${params.nodeId}.`,
                    }),
                  );
                }

                yield* workflowArtifactStore.upsertOutputError({
                  attempt: getGeneratorOutputAttempt(node, params.outputIndex),
                  error: params.message,
                  failedAt: new Date().toISOString(),
                  outputIndex: params.outputIndex,
                  nodeId: params.nodeId,
                  ownerUserId: params.userId,
                  projectId,
                  executionId: params.executionId,
                });

                const failedRun = {
                  ...currentExecution,
                  activity: params.message,
                  runtime: markRuntimeOutputFailed({
                    message: params.message,
                    nodeId: params.nodeId,
                    runtime: currentExecution.runtime,
                  }),
                  status: "running" as const,
                } satisfies WorkflowExecutionStatusResponse;
                const artifacts =
                  yield* workflowArtifactStore.getOutputArtifacts({
                    ownerUserId: params.userId,
                    executionId: params.executionId,
                  });
                const credits = yield* getExecutionCredits({
                  executionId: params.executionId,
                  userId: params.userId,
                });

                return {
                  result: null,
                  run: areOutputJobsSettledByCompletionOrFailure({
                    artifacts,
                    run: failedRun,
                  })
                    ? settleFailedOutputRun({
                        artifacts,
                        credits,
                        run: failedRun,
                      })
                    : { ...failedRun, credits },
                };
              }),
          })
          .pipe(Effect.map(({ run }) => run));

      const startExecution = (
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

          const project = yield* workflowStore.getProject({
            ownerUserId: userId,
            projectId,
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

          const executionId = randomUUID();
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
          const artifactNodeIds = getExecutionArtifactNodeIds(
            submittedRequest.document,
            targetNodeIds,
          );
          const executionPlan = buildWorkflowExecutionPlan(
            submittedRequest.document,
            artifactNodeIds,
          );
          const reusableOutputs = yield* getReusablePriorOutputs({
            document: submittedRequest.document,
            excludeExecutionId: executionId,
            ownerUserId: userId,
            projectId,
            requestedTargetNodeIds: targetNodeIds,
            targetNodeIds: artifactNodeIds,
          });
          const executionRequest = {
            ...submittedRequest,
            selection: { nodeIds: executionPlan.executableNodeIds },
            target: { type: "selected-or-all" as const },
          } satisfies StartWorkflowExecutionRequest;
          const credits =
            yield* workflowCreditsService.getBalanceSummary(userId);
          const initialExecution = buildWorkflowExecutionStatusResponse({
            executionId,
            targetNodeIds: artifactNodeIds,
            accruedCostCredits: 0,
            projectDocumentRevision: project.documentRevision,
            document: submittedRequest.document,
            runtime: createWorkflowExecutionRuntimeState(
              submittedRequest.document,
              "Queued workflow execution.",
            ),
            requestContext: {
              accruedCostCredits: 0,
              clientExecutionId: submittedRequest.clientExecutionId ?? null,
              documentRevision: submittedRequest.documentRevision ?? null,
              idempotencyKey: submittedRequest.idempotencyKey ?? null,
              projectId,
              selection: submittedRequest.selection ?? null,
              target: submittedRequest.target,
            },
            credits,
            status: "queued",
          });

          let run = yield* workflowExecutionStore.createExecution({
            ownerUserId: userId,
            projectId,
            run: initialExecution,
          });

          if (reusableOutputs.length) {
            yield* workflowArtifactStore
              .copyReusableOutputs({
                outputs: reusableOutputs,
                ownerUserId: userId,
                projectId,
                executionId,
              })
              .pipe(
                Effect.catchAll((error) =>
                  failExecution({
                    message: "Failed to seed reusable workflow output outputs.",
                    executionId,
                    userId,
                  }).pipe(
                    Effect.catchAll((cleanupError) => {
                      console.error(
                        "Failed to mark workflow execution as errored after output reuse failure",
                        cleanupError,
                      );
                      return Effect.void;
                    }),
                    Effect.zipRight(Effect.fail(error)),
                  ),
                ),
              );
            const seededArtifacts =
              yield* workflowArtifactStore.getOutputArtifacts({
                ownerUserId: userId,
                executionId,
              });
            run = yield* workflowExecutionStore
              .updateExecution({
                ...run,
                document: buildWorkflowOutputProjection({
                  artifacts: seededArtifacts,
                  document: run.document,
                }),
              })
              .pipe(Effect.mapError(toPersistenceError));
          }

          const outputCount = getExecutionOutputCount(
            submittedRequest.document,
            artifactNodeIds,
          );
          const plannedOutputCount = getExecutionDependencyPlan(
            submittedRequest.document,
            artifactNodeIds,
          ).jobs.length;
          const artifacts = yield* workflowArtifactStore.getOutputArtifacts({
            ownerUserId: userId,
            executionId,
          });
          const readyJobs = yield* getSchedulableReadyOutputJobs({
            artifacts,
            request: submittedRequest,
            executionId,
            targetNodeIds: artifactNodeIds,
          });

          console.info("Workflow start output reuse plan", {
            projectId,
            reusableOutputCount: reusableOutputs.length,
            executionId,
            scheduledOutputCount: readyJobs.length,
            totalPlannedOutputCount: plannedOutputCount,
          });

          if (!readyJobs.length) {
            const settlement = getWorkflowOutputSettlement({
              artifacts,
              plan: buildWorkflowOutputDependencyPlan({
                document: submittedRequest.document,
                generatorIterationById: executionPlan.generatorIterationById,
                targetNodeIds: artifactNodeIds,
              }),
            });
            if (settlement.settled && !settlement.failedOutputs.size) {
              const settledRun = {
                ...run,
                activity: "Workflow execution finished.",
                finalCostCredits: 0,
                runtime: {
                  ...run.runtime,
                  activity: "Workflow execution finished.",
                  error: null,
                  finishedAt: new Date().toISOString(),
                },
                status: "success" as const,
              } satisfies WorkflowExecutionStatusResponse;
              const settledCredits = yield* getExecutionCredits({
                executionId,
                userId,
              });

              return yield* workflowExecutionStore
                .updateExecution({
                  ...settledRun,
                  credits: settledCredits,
                })
                .pipe(Effect.mapError(toPersistenceError));
            }
          }

          yield* enqueueOutputJobs({
            artifacts,
            jobs: readyJobs,
            outputCount,
            request: executionRequest,
            executionId,
            userId,
          }).pipe(
            Effect.catchAll((error) =>
              failExecution({
                message: "Failed to queue workflow execution.",
                executionId,
                userId,
              }).pipe(
                Effect.catchAll((cleanupError) => {
                  console.error(
                    "Failed to mark workflow execution as errored after queue failure",
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

      const executeExecution = (
        executionId: string,
        userId: string,
        submittedRequest: StartWorkflowExecutionRequest,
        taskInputSnapshot: NonNullable<
          ReturnType<typeof getTaskRunExecutionDocumentSnapshot>
        >,
      ) =>
        Effect.gen(function* () {
          const request = submittedRequest;
          const workflowId = request.projectId?.trim();
          if (!workflowId) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Workflow execution requires a workflow project.",
              }),
            );
          }
          const chargedOutputCosts = new Map<string, number>();

          return yield* executeWorkflow({
            request,
            executionId,
            ports: {
              generateImage: (imageRequest) =>
                vertexAi.generateImagesWithNanoBananaPro({
                  ownerUserId: userId,
                  projectId: workflowId,
                  request: imageRequest,
                }),
              generateVideo: (videoRequest) =>
                vertexAi.generateVideosWithVeo31({
                  ownerUserId: userId,
                  projectId: workflowId,
                  request: videoRequest,
                }),
              generateLlm: (llmRequest) =>
                vertexAi.generateTextWithGemini3Flash({
                  ownerUserId: userId,
                  projectId: workflowId,
                  request: llmRequest,
                }),
              getNodeOutput: () => Effect.succeed(null),
              onOutputCost: (cost) =>
                chargeOutputCost({
                  ...cost,
                  executionId,
                  projectId: request.projectId ?? null,
                  taskRunId: taskInputSnapshot.taskRunId,
                  userId,
                }).pipe(
                  Effect.map(({ amount, outputKey }) => {
                    chargedOutputCosts.set(outputKey, amount);
                    return amount;
                  }),
                ),
              getNodeOutputValue: (query) =>
                Effect.succeed(
                  getTaskRunSnapshotOutputValue(taskInputSnapshot, query),
                ),
              onCompleted: ({ document, finalCostCredits, targetNodeIds }) =>
                Effect.gen(function* () {
                  const run = buildWorkflowExecutionStatusResponse({
                    executionId,
                    targetNodeIds,
                    accruedCostCredits: finalCostCredits,
                    projectDocumentRevision: request.documentRevision ?? null,
                    finalCostCredits,
                    document,
                    runtime: createWorkflowExecutionRuntimeState(
                      document,
                      "Workflow execution finished.",
                    ),
                    requestContext: {
                      accruedCostCredits: finalCostCredits,
                      clientExecutionId: request.clientExecutionId ?? null,
                      documentRevision: request.documentRevision ?? null,
                      idempotencyKey: request.idempotencyKey ?? null,
                      projectId: request.projectId ?? null,
                      selection: request.selection ?? null,
                      target: request.target,
                    },
                    status: "success",
                  });

                  return yield* persistOutputArtifacts(
                    run,
                    userId,
                    getRequestOutputIndex(request),
                    chargedOutputCosts,
                  );
                }),
              onStateChange: (state) =>
                Effect.gen(function* () {
                  const credits =
                    yield* workflowCreditsService.getExecutionSummary({
                      executionId,
                      userId,
                    });
                  const outputIndex = getRequestOutputIndex(request);
                  if (outputIndex === null) {
                    yield* workflowExecutionStore
                      .updateExecution({
                        ...state,
                        credits,
                      })
                      .pipe(Effect.orDie, Effect.asVoid);
                    return;
                  }

                  if (!hasOutput(state, outputIndex)) {
                    yield* workflowExecutionStore
                      .updateExecutionWith({
                        executionId,
                        userId,
                        update: (currentExecution) =>
                          Effect.succeed({
                            result: null,
                            run:
                              currentExecution.status === "queued" ||
                              currentExecution.status === "running" ||
                              currentExecution.status === "waiting_for_review"
                                ? {
                                    ...currentExecution,
                                    activity: state.runtime.activity,
                                    credits,
                                    runtime: mergeRuntimeState({
                                      currentRuntime: currentExecution.runtime,
                                      stateRuntime: state.runtime,
                                    }),
                                    status:
                                      currentExecution.status === "queued"
                                        ? ("running" as const)
                                        : currentExecution.status,
                                  }
                                : currentExecution,
                          }),
                      })
                      .pipe(Effect.orDie, Effect.asVoid);
                    return;
                  }

                  yield* workflowExecutionStore
                    .updateExecutionWith({
                      executionId,
                      userId,
                      update: (currentExecution) =>
                        Effect.try({
                          try: () => ({
                            result: null,
                            run:
                              currentExecution.status === "waiting_for_review"
                                ? {
                                    ...mergeOutputScopedExecutionState({
                                      accruedCostCredits:
                                        currentExecution.accruedCostCredits,
                                      currentExecution,
                                      outputIndex,
                                      state,
                                    }),
                                    credits,
                                  }
                                : currentExecution.status === "queued" ||
                                    currentExecution.status === "running"
                                  ? {
                                      ...mergeOutputScopedExecutionState({
                                        accruedCostCredits:
                                          currentExecution.accruedCostCredits,
                                        currentExecution,
                                        outputIndex,
                                        state,
                                      }),
                                      credits,
                                      status: "running" as const,
                                    }
                                  : currentExecution,
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
                const executionOutputFilter = request.executionOutputFilter;
                if (state.status === "success" && executionOutputFilter) {
                  return yield* workflowExecutionStore
                    .updateExecutionWith({
                      executionId,
                      userId,
                      update: (currentExecution) =>
                        Effect.gen(function* () {
                          if (
                            currentExecution.status !== "queued" &&
                            currentExecution.status !== "running"
                          ) {
                            return { result: null, run: currentExecution };
                          }

                          const nextState = yield* Effect.try({
                            try: () =>
                              mergeOutputScopedExecutionState({
                                accruedCostCredits:
                                  currentExecution.accruedCostCredits +
                                  getFilteredContinuationCostDelta(
                                    state,
                                    request,
                                  ),
                                currentExecution,
                                outputIndex: executionOutputFilter.outputIndex,
                                state,
                              }),
                            catch: toPersistenceError,
                          });
                          yield* persistOutputArtifacts(
                            nextState,
                            userId,
                            executionOutputFilter.outputIndex,
                            chargedOutputCosts,
                          );
                          const artifacts =
                            yield* workflowArtifactStore.getOutputArtifacts({
                              ownerUserId: userId,
                              executionId,
                            });
                          const isComplete = areExecutionOutputsComplete(
                            nextState,
                            executionOutputFilter.outputCount,
                            artifacts,
                          );
                          if (!isComplete) {
                            yield* enqueueReadyOutputJobs({
                              artifacts,
                              outputCount: executionOutputFilter.outputCount,
                              request,
                              executionId,
                              run: nextState,
                              targetNodeIds: currentExecution.targetNodeIds,
                              userId,
                            });
                          }
                          const isSettledByFailure =
                            !isComplete &&
                            areOutputJobsSettledByCompletionOrFailure({
                              artifacts,
                              run: nextState,
                            });
                          const settledRun = isComplete
                            ? {
                                ...nextState,
                                finalCostCredits: nextState.accruedCostCredits,
                                runtime: {
                                  ...nextState.runtime,
                                  activity: "Workflow execution finished.",
                                  error: null,
                                  finishedAt: new Date().toISOString(),
                                },
                                status: "success" as const,
                              }
                            : isSettledByFailure
                              ? {
                                  ...nextState,
                                  finalCostCredits:
                                    nextState.accruedCostCredits,
                                  runtime: {
                                    ...nextState.runtime,
                                    activity:
                                      getOutputFailureMessage(artifacts),
                                    error: getOutputFailureMessage(artifacts),
                                    finishedAt: new Date().toISOString(),
                                  },
                                  status: "error" as const,
                                }
                              : {
                                  ...nextState,
                                  finalCostCredits: null,
                                  runtime: {
                                    ...nextState.runtime,
                                    activity: `Output ${executionOutputFilter.outputIndex + 1} completed. Waiting for remaining outputs...`,
                                    finishedAt: null,
                                  },
                                  status: "running" as const,
                                };
                          const runWithRevision = withProjectDocumentRevision(
                            settledRun,
                            settledRun.projectDocumentRevision,
                          );
                          const credits = yield* getExecutionCredits({
                            executionId,
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

                if (state.status === "running" && executionOutputFilter) {
                  return yield* workflowExecutionStore
                    .updateExecutionWith({
                      executionId,
                      userId,
                      update: (currentExecution) =>
                        Effect.succeed({
                          result: null,
                          run:
                            currentExecution.status === "queued" ||
                            currentExecution.status === "running"
                              ? {
                                  ...currentExecution,
                                  runtime: {
                                    ...currentExecution.runtime,
                                    activity: state.runtime.activity,
                                    error: null,
                                    finishedAt: null,
                                  },
                                  status: "running" as const,
                                }
                              : currentExecution,
                        }),
                    })
                    .pipe(Effect.map(({ run }) => run));
                }

                const reviewOutputFilter = request.reviewOutputFilter;
                if (state.status === "success" && reviewOutputFilter) {
                  return yield* workflowExecutionStore
                    .updateExecutionWith({
                      executionId,
                      userId,
                      update: (currentExecution) =>
                        Effect.gen(function* () {
                          if (
                            currentExecution.status !== "queued" &&
                            !canDecideReviewOutput(currentExecution)
                          ) {
                            return { result: null, run: currentExecution };
                          }

                          const nextState = yield* Effect.try({
                            try: () =>
                              mergeOutputScopedExecutionState({
                                accruedCostCredits:
                                  currentExecution.accruedCostCredits +
                                  getFilteredContinuationCostDelta(
                                    state,
                                    request,
                                  ),
                                currentExecution,
                                outputIndex: reviewOutputFilter.outputIndex,
                                state,
                              }),
                            catch: toPersistenceError,
                          });
                          const documentRevision =
                            yield* persistOutputArtifacts(
                              nextState,
                              userId,
                              reviewOutputFilter.outputIndex,
                              chargedOutputCosts,
                            );
                          const credits =
                            yield* workflowCreditsService.getExecutionSummary({
                              executionId,
                              userId,
                            });
                          const status =
                            currentExecution.status === "queued"
                              ? ("queued" as const)
                              : currentExecution.status === "running"
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
                                    ? currentExecution.runtime.activity
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
                  const credits = yield* getExecutionCredits({
                    executionId,
                    userId,
                  });
                  return yield* workflowExecutionStore.updateExecution({
                    ...state,
                    credits,
                  });
                }

                if (state.status === "waiting_for_review") {
                  const executionOutputFilter = request.executionOutputFilter;
                  if (executionOutputFilter) {
                    return yield* workflowExecutionStore
                      .updateExecutionWith({
                        executionId,
                        userId,
                        update: (currentExecution) =>
                          Effect.gen(function* () {
                            if (
                              currentExecution.status !== "queued" &&
                              currentExecution.status !== "running" &&
                              currentExecution.status !== "waiting_for_review"
                            ) {
                              return {
                                result: null,
                                run: currentExecution,
                              };
                            }

                            const nextState = yield* Effect.try({
                              try: () =>
                                mergeOutputScopedExecutionState({
                                  accruedCostCredits:
                                    currentExecution.accruedCostCredits +
                                    getFilteredContinuationCostDelta(
                                      state,
                                      request,
                                    ),
                                  currentExecution,
                                  outputIndex:
                                    executionOutputFilter.outputIndex,
                                  state,
                                }),
                              catch: toPersistenceError,
                            });
                            yield* persistOutputArtifacts(
                              nextState,
                              userId,
                              executionOutputFilter.outputIndex,
                              chargedOutputCosts,
                            );
                            const artifacts =
                              yield* workflowArtifactStore.getOutputArtifacts({
                                ownerUserId: userId,
                                executionId,
                              });
                            const isComplete = areExecutionOutputsComplete(
                              nextState,
                              executionOutputFilter.outputCount,
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
                                    activity: `Output ${executionOutputFilter.outputIndex + 1} reached review. Waiting for remaining outputs...`,
                                    finishedAt: null,
                                  },
                                  status: "running" as const,
                                };
                            const runWithRevision = withProjectDocumentRevision(
                              settledRun,
                              settledRun.projectDocumentRevision,
                            );
                            const credits = yield* getExecutionCredits({
                              executionId,
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

                  if (reviewOutputFilter) {
                    return yield* workflowExecutionStore
                      .updateExecutionWith({
                        executionId,
                        userId,
                        update: (currentExecution) =>
                          Effect.gen(function* () {
                            if (!canDecideReviewOutput(currentExecution)) {
                              return {
                                result: null,
                                run: currentExecution,
                              };
                            }

                            const nextState = yield* Effect.try({
                              try: () =>
                                mergeOutputScopedExecutionState({
                                  accruedCostCredits:
                                    currentExecution.accruedCostCredits +
                                    getFilteredContinuationCostDelta(
                                      state,
                                      request,
                                    ),
                                  currentExecution,
                                  outputIndex: reviewOutputFilter.outputIndex,
                                  state,
                                }),
                              catch: toPersistenceError,
                            });
                            const credits = yield* getExecutionCredits({
                              executionId,
                              userId,
                            });
                            const documentRevision =
                              yield* persistOutputArtifacts(
                                nextState,
                                userId,
                                reviewOutputFilter.outputIndex,
                                chargedOutputCosts,
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
                                  currentExecution.status === "running"
                                    ? ("running" as const)
                                    : ("waiting_for_review" as const),
                              },
                            };
                          }),
                      })
                      .pipe(Effect.map(({ run }) => run));
                  }

                  const nextState = state;
                  const credits = yield* getExecutionCredits({
                    executionId,
                    userId,
                  });
                  const documentRevision = yield* persistOutputArtifacts(
                    nextState,
                    userId,
                    null,
                    chargedOutputCosts,
                  );
                  return yield* workflowExecutionStore.updateExecution({
                    ...withProjectDocumentRevision(nextState, documentRevision),
                    credits,
                  });
                }
              }),
            ),
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                const currentExecution =
                  yield* workflowExecutionStore.getExecution({
                    executionId,
                    userId,
                  });

                if (currentExecution.status === "success") {
                  const credits = yield* workflowCreditsService
                    .getExecutionSummary({
                      executionId,
                      userId,
                    })
                    .pipe(
                      Effect.catchAll(() =>
                        Effect.succeed(currentExecution.credits),
                      ),
                    );
                  const nextExecution = {
                    ...currentExecution,
                    credits,
                  };

                  return yield* workflowExecutionStore
                    .updateExecution(nextExecution)
                    .pipe(Effect.catchAll(() => Effect.succeed(nextExecution)));
                }

                const credits = yield* getExecutionCredits({
                  executionId,
                  userId,
                });
                const failureMessage = getErrorMessage(error);
                yield* workflowExecutionStore.updateExecution({
                  ...currentExecution,
                  activity:
                    request.executionOutputFilter || request.reviewOutputFilter
                      ? failureMessage
                      : currentExecution.activity,
                  credits,
                  runtime:
                    request.executionOutputFilter || request.reviewOutputFilter
                      ? {
                          ...currentExecution.runtime,
                          activity: failureMessage,
                          error: failureMessage,
                        }
                      : currentExecution.runtime,
                  status:
                    error instanceof WorkflowOutputDependencyMissing
                      ? "error"
                      : request.executionOutputFilter &&
                          currentExecution.status === "queued"
                        ? "running"
                        : currentExecution.status,
                });
                return yield* Effect.fail(error);
              }),
            ),
          );
        });

      const executeTaskRun = (taskRunId: string, userId: string) =>
        Effect.gen(function* () {
          const claim = yield* claimQueuedWorkflowTaskRun({
            taskRunId,
            userId,
          });
          const taskRun = claim.row;

          if (!taskRun) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: `Task run ${taskRunId} was not found.`,
              }),
            );
          }

          if (!claim.claimed || taskRun.status !== "running") {
            return null;
          }

          const snapshot = getTaskRunExecutionDocumentSnapshot(taskRun);
          if (!snapshot) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: `Task run ${taskRunId} is missing its input snapshot.`,
              }),
            );
          }

          return yield* executeExecution(
            taskRun.executionId,
            userId,
            toTaskRunExecutionRequest(snapshot),
            snapshot,
          );
        });

      const settleFailedTaskRun = (params: {
        message: string;
        taskRunId: string;
        userId: string;
      }) =>
        Effect.gen(function* () {
          const taskRun = yield* Effect.tryPromise({
            try: () =>
              db
                .select()
                .from(taskRuns)
                .where(
                  and(
                    eq(taskRuns.id, params.taskRunId),
                    eq(taskRuns.ownerUserId, params.userId),
                  ),
                )
                .limit(1)
                .then((rows) => rows[0] ?? null),
            catch: toPersistenceError,
          });

          if (!taskRun) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: `Task run ${params.taskRunId} was not found.`,
              }),
            );
          }

          yield* Effect.tryPromise({
            try: () =>
              db
                .update(taskRuns)
                .set({
                  error: params.message,
                  failedAt: new Date(),
                  finishedAt: new Date(),
                  status: "error",
                  updatedAt: new Date(),
                })
                .where(eq(taskRuns.id, taskRun.id)),
            catch: toPersistenceError,
          });

          return yield* settleFailedExecutionOutput({
            executionId: taskRun.executionId,
            message: params.message,
            nodeId: taskRun.nodeId,
            outputIndex: taskRun.outputIndex,
            userId: params.userId,
          });
        });

      return WorkflowExecutionService.of({
        approveReviewOutput,
        executeTaskRun,
        failExecution,
        quoteExecution,
        rejectReviewOutput,
        settleFailedExecutionOutput,
        settleFailedTaskRun,
        startExecution,
      });
    }),
  );
}
