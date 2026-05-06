import { Effect } from "effect";
import type {
  TaskRunFailureReason,
  TaskRunSettlementFailureSource,
} from "~/features/runtime/domain/task-run-state";
import type { TaskStatusEvent } from "~/features/runtime/events/task-status-events";
import type { ExecutableTaskRunInputSnapshot } from "~/features/runtime/execution/task-run-input-snapshot";
import {
  committed,
  ignored,
  type RuntimeCommandOutcome,
} from "~/features/runtime/server/command-outcome";
import type { RuntimeRepositoryFailure } from "~/features/runtime/server/repository";
import {
  buildRuntimeCompletionSettlementJobPayload,
  buildRuntimeFailureSettlementJobPayload,
  type RuntimeCompletionSettlementJobPayload,
  type RuntimeExecutionJobPayload,
  type RuntimeFailureSettlementJobPayload,
  type RuntimeGeneratedPrimaryAssetPayload,
} from "~/server/services/queue";

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
  readonly generatedAsset: RuntimeGeneratedPrimaryAssetPayload;
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

export type RuntimeProviderExecutor = {
  readonly execute: (command: {
    readonly inputSnapshot: ExecutableTaskRunInputSnapshot;
    readonly ownerUserId: string;
    readonly workflowId: string;
  }) => Effect.Effect<ProviderExecutionResult, never>;
};

export type RuntimeExecutionWorkerRepository = {
  readonly claimQueuedTaskRun: (
    command: ClaimQueuedTaskRunForExecutionCommand,
  ) => Effect.Effect<
    ClaimQueuedTaskRunForExecutionResult,
    RuntimeRepositoryFailure
  >;
};

export type RuntimeSettlementQueueForWorker = {
  readonly enqueueCompletionSettlement: (
    payload: RuntimeCompletionSettlementJobPayload,
  ) => Effect.Effect<void, unknown>;
  readonly enqueueFailureSettlement: (
    payload: RuntimeFailureSettlementJobPayload,
  ) => Effect.Effect<void, unknown>;
};

export type EventPublisherServiceForWorker = {
  readonly publishTaskStatusEvent: (
    workflowId: string,
    event: TaskStatusEvent,
  ) => Effect.Effect<void, unknown>;
};

type RuntimeExecutionWorkerValue = {
  readonly settlement:
    | RuntimeCompletionSettlementJobPayload
    | RuntimeFailureSettlementJobPayload;
};

export type RuntimeExecutionWorkerResult =
  RuntimeCommandOutcome<RuntimeExecutionWorkerValue>;

export function createRuntimeExecutionWorker(input: {
  readonly eventPublisher: EventPublisherServiceForWorker;
  readonly providerExecutor: RuntimeProviderExecutor;
  readonly repository: RuntimeExecutionWorkerRepository;
  readonly settlementQueue: RuntimeSettlementQueueForWorker;
}) {
  const executeEffect = (job: RuntimeExecutionJobPayload) =>
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
        return ignored<RuntimeExecutionWorkerValue>("STALE_TASK_RUN");
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
        const settlement = buildRuntimeFailureSettlementJobPayload({
          attempt: job.attempt,
          failureReason: providerResult.error.failureReason,
          failureSource: providerResult.error.failureSource,
          providerCostCredits: providerResult.error.providerCostCredits,
          ownerUserId: job.ownerUserId,
          taskRunId: job.taskRunId,
          workflowId: job.workflowId,
        });
        yield* input.settlementQueue.enqueueFailureSettlement(settlement);

        return committedSettlement(settlement);
      }

      const settlement = buildRuntimeCompletionSettlementJobPayload({
        attempt: job.attempt,
        providerCostCredits: providerResult.value.providerCostCredits,
        generatedAsset: providerResult.value.generatedAsset,
        ownerUserId: job.ownerUserId,
        reviewRequired: providerResult.value.reviewRequired,
        taskRunId: job.taskRunId,
        workflowId: job.workflowId,
      });
      yield* input.settlementQueue.enqueueCompletionSettlement(settlement);

      return committedSettlement(settlement);
    });

  return {
    async execute(
      job: RuntimeExecutionJobPayload,
    ): Promise<RuntimeExecutionWorkerResult> {
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

function committedSettlement(
  settlement:
    | RuntimeCompletionSettlementJobPayload
    | RuntimeFailureSettlementJobPayload,
): RuntimeExecutionWorkerResult {
  return committed({ settlement });
}
