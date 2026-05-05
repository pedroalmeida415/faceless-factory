import type {
  TaskRunFailureReason,
  TaskRunSettlementFailureSource,
} from "~/lib/workflow-runtime/domain/task-run-state";
import type { ExecutableTaskRunInputSnapshot } from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
import type { TaskStatusEvent } from "~/lib/workflow-runtime/runtime/task-status-events";
import {
  buildWorkflowRuntimeCompletionSettlementJobPayload,
  buildWorkflowRuntimeFailureSettlementJobPayload,
  type WorkflowRuntimeCompletionSettlementJobPayload,
  type WorkflowRuntimeExecutionJobPayload,
  type WorkflowRuntimeFailureSettlementJobPayload,
  type WorkflowRuntimeGeneratedPrimaryAssetPayload,
} from "~/server/workflow-runtime/workflow-runtime-queue";

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
  }) => Promise<ProviderExecutionResult>;
};

export type WorkflowRuntimeExecutionWorkerRepository = {
  readonly claimQueuedTaskRun: (
    command: ClaimQueuedTaskRunForExecutionCommand,
  ) => Promise<ClaimQueuedTaskRunForExecutionResult>;
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
  readonly publishTaskStatusEvents: (
    workflowId: string,
    events: readonly TaskStatusEvent[],
  ) => Promise<void>;
};

export type WorkflowRuntimeExecutionWorkerResult =
  | { readonly claimed: false }
  | {
      readonly claimed: true;
      readonly settlement:
        | WorkflowRuntimeCompletionSettlementJobPayload
        | WorkflowRuntimeFailureSettlementJobPayload;
    };

export function createWorkflowRuntimeExecutionWorker(input: {
  readonly eventPublisher: WorkflowRuntimeEventPublisherForWorker;
  readonly providerExecutor: WorkflowRuntimeProviderExecutor;
  readonly repository: WorkflowRuntimeExecutionWorkerRepository;
  readonly settlementQueue: WorkflowRuntimeSettlementQueueForWorker;
}) {
  return {
    async execute(
      job: WorkflowRuntimeExecutionJobPayload,
    ): Promise<WorkflowRuntimeExecutionWorkerResult> {
      const claim = await input.repository.claimQueuedTaskRun({
        attempt: job.attempt,
        ownerUserId: job.ownerUserId,
        taskRunId: job.taskRunId,
      });

      if (!claim.claimed) {
        return { claimed: false };
      }

      await input.eventPublisher.publishTaskStatusEvents(job.workflowId, [
        claim.event,
      ]);

      const providerResult = await Promise.resolve()
        .then(() =>
          input.providerExecutor.execute({
            inputSnapshot: claim.inputSnapshot,
            ownerUserId: job.ownerUserId,
            workflowId: job.workflowId,
          }),
        )
        .catch(
          (cause: unknown): ProviderExecutionResult => ({
            error: {
              failureReason: {
                message: providerFailureMessage(cause),
                type: "PROVIDER_FAILED",
              },
              failureSource: {
                taskRunDebitRefundable: false,
                type: "POST_PROVIDER_INFRASTRUCTURE",
              },
            },
            ok: false,
          }),
        );
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
        await input.settlementQueue.enqueueFailureSettlement(settlement);

        return { claimed: true, settlement };
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
      await input.settlementQueue.enqueueCompletionSettlement(settlement);

      return { claimed: true, settlement };
    },
  };
}

function providerFailureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "Provider execution failed.";
}
