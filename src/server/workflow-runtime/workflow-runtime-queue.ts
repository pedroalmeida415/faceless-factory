import type {
  TaskRunFailureReason,
  TaskRunSettlementFailureSource,
} from "~/lib/workflow-runtime/domain/task-run-state";
import {
  buildExecutionJobId,
  buildOrchestratorEventId,
  buildWakeUpJobId,
} from "~/lib/workflow-runtime/runtime/task-status-events";

export const WORKFLOW_RUNTIME_EXECUTION_JOB_NAME = "execute-task-run";
export const WORKFLOW_RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME =
  "settle-task-run-completion";
export const WORKFLOW_RUNTIME_FAILURE_SETTLEMENT_JOB_NAME =
  "settle-task-run-failure";
export const WORKFLOW_RUNTIME_WAKE_UP_JOB_NAME = "wake-up-task-run-children";

export type WorkflowRuntimeExecutionJobPayload = {
  readonly attempt: number;
  readonly itemIndex: number;
  readonly jobId: string;
  readonly nodeExecutionId: string;
  readonly ownerUserId: string;
  readonly taskRunId: string;
  readonly workflowId: string;
};

export type WorkflowRuntimeWakeUpJobPayload = {
  readonly jobId: string;
  readonly ownerUserId: string;
  readonly parentTaskRunId: string;
  readonly workflowId: string;
};

type WorkflowRuntimeGeneratedPrimaryAssetPayloadBase = {
  readonly assetId: string;
  readonly contentType: string;
  readonly externalUri?: string | null;
  readonly fileName: string;
  readonly model?: string | null;
  readonly sizeBytes: number;
  readonly stagedStorageKey?: string | null;
  readonly storageKey?: string | null;
  readonly storageProvider: string;
};

export type WorkflowRuntimeGeneratedPrimaryAssetPayload =
  | (WorkflowRuntimeGeneratedPrimaryAssetPayloadBase & {
      readonly kind: "text";
      readonly text: string;
    })
  | (WorkflowRuntimeGeneratedPrimaryAssetPayloadBase & {
      readonly cdnUrl: string;
      readonly kind: "image" | "video";
    });

export type WorkflowRuntimeCompletionSettlementJobPayload = {
  readonly attempt: number;
  readonly providerCostCredits: number;
  readonly generatedAsset: WorkflowRuntimeGeneratedPrimaryAssetPayload;
  readonly jobId: string;
  readonly ownerUserId: string;
  readonly reviewRequired: boolean;
  readonly taskRunId: string;
  readonly workflowId: string;
};

export type WorkflowRuntimeFailureSettlementJobPayload = {
  readonly attempt: number;
  readonly failureReason: Exclude<
    TaskRunFailureReason,
    { readonly type: "UPSTREAM_FAILED" }
  >;
  readonly failureSource: TaskRunSettlementFailureSource;
  readonly providerCostCredits?: number;
  readonly jobId: string;
  readonly ownerUserId: string;
  readonly taskRunId: string;
  readonly workflowId: string;
};

export type BuildWorkflowRuntimeExecutionJobPayloadInput = Omit<
  WorkflowRuntimeExecutionJobPayload,
  "jobId"
>;

export function buildWorkflowRuntimeExecutionJobPayload(
  input: BuildWorkflowRuntimeExecutionJobPayloadInput,
): WorkflowRuntimeExecutionJobPayload {
  return {
    ...input,
    jobId: buildExecutionJobId(input),
  };
}

export type BuildWorkflowRuntimeCompletionSettlementJobPayloadInput = Omit<
  WorkflowRuntimeCompletionSettlementJobPayload,
  "jobId"
>;

export function buildWorkflowRuntimeCompletionSettlementJobPayload(
  input: BuildWorkflowRuntimeCompletionSettlementJobPayloadInput,
): WorkflowRuntimeCompletionSettlementJobPayload {
  return {
    ...input,
    jobId: buildOrchestratorEventId({
      attempt: input.attempt,
      kind: "completion",
      taskRunId: input.taskRunId,
    }),
  };
}

export type BuildWorkflowRuntimeFailureSettlementJobPayloadInput = Omit<
  WorkflowRuntimeFailureSettlementJobPayload,
  "jobId"
>;

export function buildWorkflowRuntimeFailureSettlementJobPayload(
  input: BuildWorkflowRuntimeFailureSettlementJobPayloadInput,
): WorkflowRuntimeFailureSettlementJobPayload {
  return {
    jobId: buildOrchestratorEventId({
      attempt: input.attempt,
      kind: "failure",
      taskRunId: input.taskRunId,
    }),
    ...(input.providerCostCredits === undefined
      ? {
          attempt: input.attempt,
          failureReason: input.failureReason,
          failureSource: input.failureSource,
          ownerUserId: input.ownerUserId,
          taskRunId: input.taskRunId,
          workflowId: input.workflowId,
        }
      : input),
  };
}

export type BuildWorkflowRuntimeWakeUpJobPayloadInput = Omit<
  WorkflowRuntimeWakeUpJobPayload,
  "jobId"
>;

export type WorkflowRuntimeQueueLike = {
  readonly add: (
    name: string,
    payload:
      | WorkflowRuntimeCompletionSettlementJobPayload
      | WorkflowRuntimeExecutionJobPayload
      | WorkflowRuntimeFailureSettlementJobPayload
      | WorkflowRuntimeWakeUpJobPayload,
    options: { readonly jobId: string },
  ) => Promise<unknown>;
};

export function buildWorkflowRuntimeWakeUpJobPayload(
  input: BuildWorkflowRuntimeWakeUpJobPayloadInput,
): WorkflowRuntimeWakeUpJobPayload {
  return {
    ...input,
    jobId: buildWakeUpJobId(input),
  };
}

export function createWorkflowRuntimeQueueAdapter(
  queue: WorkflowRuntimeQueueLike,
) {
  return {
    async enqueueExecutionJobs(
      jobs: readonly WorkflowRuntimeExecutionJobPayload[],
    ): Promise<void> {
      for (const job of jobs) {
        await queue.add(WORKFLOW_RUNTIME_EXECUTION_JOB_NAME, job, {
          jobId: job.jobId,
        });
      }
    },

    async enqueueCompletionSettlement(
      job: WorkflowRuntimeCompletionSettlementJobPayload,
    ): Promise<void> {
      await queue.add(WORKFLOW_RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME, job, {
        jobId: job.jobId,
      });
    },

    async enqueueFailureSettlement(
      job: WorkflowRuntimeFailureSettlementJobPayload,
    ): Promise<void> {
      await queue.add(WORKFLOW_RUNTIME_FAILURE_SETTLEMENT_JOB_NAME, job, {
        jobId: job.jobId,
      });
    },

    async enqueueWakeUpJobs(
      jobs: readonly WorkflowRuntimeWakeUpJobPayload[],
    ): Promise<void> {
      for (const job of jobs) {
        await queue.add(WORKFLOW_RUNTIME_WAKE_UP_JOB_NAME, job, {
          jobId: job.jobId,
        });
      }
    },
  };
}
