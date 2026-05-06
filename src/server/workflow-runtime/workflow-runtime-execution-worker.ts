import { Effect } from "effect";
import type {
  TaskRunFailureReason,
  TaskRunSettlementFailureSource,
} from "~/lib/workflow-runtime/domain/task-run-state";
import type { ExecutableTaskRunInputSnapshot } from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
import type { TaskStatusEvent } from "~/lib/workflow-runtime/runtime/task-status-events";
import {
  committed,
  ignored,
  type WorkflowRuntimeCommandOutcome,
} from "~/server/workflow-runtime/workflow-runtime-command-outcome";
import {
  buildWorkflowRuntimeCompletionSettlementJobPayload,
  buildWorkflowRuntimeFailureSettlementJobPayload,
  type WorkflowRuntimeCompletionSettlementJobPayload,
  type WorkflowRuntimeExecutionJobPayload,
  type WorkflowRuntimeFailureSettlementJobPayload,
  type WorkflowRuntimeGeneratedPrimaryAssetPayload,
} from "~/server/workflow-runtime/workflow-runtime-queue";
import type { WorkflowRuntimeRepositoryFailure } from "~/server/workflow-runtime/workflow-runtime-repository";

export type ClaimQueuedTaskRunForExecutionCommand = {
  readonly attempt: number;
  readonly ownerUserId: string;
  readonly taskRunId: string;
};

export type ClaimQueuedTaskRunForExecutionResult =
  | {
      readonly claimed: true;
      readonly event: TaskStatusEvent;
      readonly inputSnapshot: ExecutableTaskRunInputSnapshot;
    }
  | { readonly claimed: false };

export type ProviderExecutionCompletion = {
  readonly providerCostCredits: number;
  readonly generatedAsset: WorkflowRuntimeGeneratedPrimaryAssetPayload;
  readonly reviewRequired: boolean;
};

export type ProviderExecutionFailure = {
  readonly failureReason: Exclude<
    TaskRunFailureReason,
    { readonly type: "UPSTREAM_FAILED" }
  >;
  readonly failureSource: TaskRunSettlementFailureSource;
  readonly providerCostCredits?: number;
};

export type ProviderExecutionResult =
  | { readonly ok: true; readonly value: ProviderExecutionCompletion }
  | { readonly ok: false; readonly error: ProviderExecutionFailure };

export type WorkflowRuntimeProviderExecutor = {
  readonly execute: (command: {
    readonly inputSnapshot: ExecutableTaskRunInputSnapshot;
    readonly ownerUserId: string;
    readonly workflowId: string;
  }) => Effect.Effect<ProviderExecutionResult, never>;
};

export type WorkflowRuntimeExecutionWorkerRepository = {
  readonly claimQueuedTaskRun: (
    command: ClaimQueuedTaskRunForExecutionCommand,
  ) => Effect.Effect<
    ClaimQueuedTaskRunForExecutionResult,
    WorkflowRuntimeRepositoryFailure
  >;
};

export type WorkflowRuntimeSettlementQueueForWorker = {
  readonly enqueueCompletionSettlement: (
    payload: WorkflowRuntimeCompletionSettlementJobPayload,
  ) => Promise<void>;
  readonly enqueueFailureSettlement: (
    payload: WorkflowRuntimeFailureSettlementJobPayload,
  ) => Promise<void>;
};

export type WorkflowRuntimeEventPublisherForWorker = {
  readonly publishTaskStatusEvent: (
    workflowId: string,
    event: TaskStatusEvent,
  ) => Effect.Effect<void, unknown>;
};

type WorkflowRuntimeExecutionWorkerValue = {
  readonly settlement:
    | WorkflowRuntimeCompletionSettlementJobPayload
    | WorkflowRuntimeFailureSettlementJobPayload;
};

export type WorkflowRuntimeExecutionWorkerResult =
  WorkflowRuntimeCommandOutcome<WorkflowRuntimeExecutionWorkerValue>;

export function createWorkflowRuntimeExecutionWorker(input: {
  readonly eventPublisher: WorkflowRuntimeEventPublisherForWorker;
  readonly providerExecutor: WorkflowRuntimeProviderExecutor;
  readonly repository: WorkflowRuntimeExecutionWorkerRepository;
  readonly settlementQueue: WorkflowRuntimeSettlementQueueForWorker;
}) {
  const executeEffect = (job: WorkflowRuntimeExecutionJobPayload) =>
    Effect.gen(function* () {
      const claim = yield* input.repository
        .claimQueuedTaskRun({
          attempt: job.attempt,
          ownerUserId: job.ownerUserId,
          taskRunId: job.taskRunId,
        })
        .pipe(
          Effect.catchIf(isStaleTaskRunTransition, () =>
            Effect.succeed({ claimed: false as const }),
          ),
        );

      if (!claim.claimed) {
        return ignored<WorkflowRuntimeExecutionWorkerValue>("STALE_TASK_RUN");
      }

      yield* input.eventPublisher.publishTaskStatusEvent(
        job.workflowId,
        claim.event,
      );

      const providerResult = yield* input.providerExecutor.execute({
        inputSnapshot: claim.inputSnapshot,
        ownerUserId: job.ownerUserId,
        workflowId: job.workflowId,
      });
      if (!providerResult.ok) {
        const settlement = buildWorkflowRuntimeFailureSettlementJobPayload({
          attempt: job.attempt,
          failureReason: providerResult.error.failureReason,
          failureSource: providerResult.error.failureSource,
          providerCostCredits: providerResult.error.providerCostCredits,
          ownerUserId: job.ownerUserId,
          taskRunId: job.taskRunId,
          workflowId: job.workflowId,
        });
        yield* promiseInfrastructureEffect(() =>
          input.settlementQueue.enqueueFailureSettlement(settlement),
        );

        return committedSettlement(settlement);
      }

      const settlement = buildWorkflowRuntimeCompletionSettlementJobPayload({
        attempt: job.attempt,
        providerCostCredits: providerResult.value.providerCostCredits,
        generatedAsset: providerResult.value.generatedAsset,
        ownerUserId: job.ownerUserId,
        reviewRequired: providerResult.value.reviewRequired,
        taskRunId: job.taskRunId,
        workflowId: job.workflowId,
      });
      yield* promiseInfrastructureEffect(() =>
        input.settlementQueue.enqueueCompletionSettlement(settlement),
      );

      return committedSettlement(settlement);
    });

  return {
    async execute(
      job: WorkflowRuntimeExecutionJobPayload,
    ): Promise<WorkflowRuntimeExecutionWorkerResult> {
      return Effect.runPromise(executeEffect(job));
    },
  };
}

function isStaleTaskRunTransition(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "StaleTaskRunTransition"
  );
}

function promiseInfrastructureEffect<A>(tryPromise: () => Promise<A>) {
  return Effect.tryPromise({
    catch: (cause) => cause,
    try: tryPromise,
  });
}

function committedSettlement(
  settlement:
    | WorkflowRuntimeCompletionSettlementJobPayload
    | WorkflowRuntimeFailureSettlementJobPayload,
): WorkflowRuntimeExecutionWorkerResult {
  return committed({ settlement });
}
