import { Effect } from "effect";
import type {
  TaskFailureReason,
  TaskSettlementFailureSource,
} from "~/features/runtime/domain/task-state";
import type { TaskStatusEvent } from "~/features/runtime/events/task-status-events";
import type { ExecutableTaskInputSnapshot } from "~/features/runtime/execution/task-input-snapshot";
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

export type ClaimQueuedTaskForExecutionCommand = {
  readonly ownerUserId: string;
  readonly taskId: string;
};

export type ClaimQueuedTaskForExecutionResult =
  | {
      readonly claimed: true;
      readonly event: TaskStatusEvent;
      readonly inputSnapshot: ExecutableTaskInputSnapshot;
    }
  | { readonly claimed: false };

export type ProviderExecutionCompletion = {
  readonly providerCostCredits: number;
  readonly generatedAsset: RuntimeGeneratedPrimaryAssetPayload;
  readonly reviewRequired: boolean;
};

export type ProviderExecutionFailure = {
  readonly failureReason: Exclude<
    TaskFailureReason,
    { readonly type: "UPSTREAM_FAILED" }
  >;
  readonly failureSource: TaskSettlementFailureSource;
  readonly providerCostCredits?: number;
};

export type ProviderExecutionResult =
  | { readonly ok: true; readonly value: ProviderExecutionCompletion }
  | { readonly ok: false; readonly error: ProviderExecutionFailure };

export type RuntimeProviderExecutor = {
  readonly execute: (command: {
    readonly inputSnapshot: ExecutableTaskInputSnapshot;
    readonly ownerUserId: string;
    readonly workflowId: string;
  }) => Effect.Effect<ProviderExecutionResult, never>;
};

export type RuntimeExecutionWorkerRepository = {
  readonly claimQueuedTask: (
    command: ClaimQueuedTaskForExecutionCommand,
  ) => Effect.Effect<
    ClaimQueuedTaskForExecutionResult,
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
        .claimQueuedTask({
          ownerUserId: job.ownerUserId,
          taskId: job.taskId,
        })
        .pipe(
          Effect.catchIf(isStaleTaskTransition, () =>
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
          failureReason: providerResult.error.failureReason,
          failureSource: providerResult.error.failureSource,
          providerCostCredits: providerResult.error.providerCostCredits,
          ownerUserId: job.ownerUserId,
          taskId: job.taskId,
          workflowId: job.workflowId,
        });
        yield* input.settlementQueue.enqueueFailureSettlement(settlement);

        return committedSettlement(settlement);
      }

      const settlement = buildRuntimeCompletionSettlementJobPayload({
        providerCostCredits: providerResult.value.providerCostCredits,
        generatedAsset: providerResult.value.generatedAsset,
        ownerUserId: job.ownerUserId,
        reviewRequired: providerResult.value.reviewRequired,
        taskId: job.taskId,
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

function isStaleTaskTransition(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "StaleTaskTransition"
  );
}

function committedSettlement(
  settlement:
    | RuntimeCompletionSettlementJobPayload
    | RuntimeFailureSettlementJobPayload,
): RuntimeExecutionWorkerResult {
  return committed({ settlement });
}
