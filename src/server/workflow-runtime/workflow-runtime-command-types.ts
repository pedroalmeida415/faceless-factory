import type { Effect } from "effect";
import type {
  TaskRunFailureReason,
  TaskRunSettlementFailureSource,
} from "~/lib/workflow-runtime/domain/task-run-state";
import type {
  WorkflowRunPlan,
  WorkflowRunPlannerInput,
} from "~/lib/workflow-runtime/planning/workflow-run-planner";
import type { TaskStatusEvent } from "~/lib/workflow-runtime/runtime/task-status-events";
import type {
  WorkflowRuntimeExecutionJobPayload,
  WorkflowRuntimeGeneratedPrimaryAssetPayload,
  WorkflowRuntimeWakeUpJobPayload,
} from "~/server/workflow-runtime/workflow-runtime-queue";
import type {
  RepositoryCommittedOutcome,
  WakeUpTaskRunChildrenRepositoryCommand,
  WakeUpTaskRunChildrenRepositoryResult,
  WorkflowRuntimeRepositoryFailure,
} from "~/server/workflow-runtime/workflow-runtime-repository";

export type StartWorkflowRunInput = Omit<
  WorkflowRunPlannerInput,
  "createNodeExecutionId" | "createTaskRunId"
>;

export type WorkflowRuntimeCommitPlanResult = {
  readonly executionJobs: readonly WorkflowRuntimeExecutionJobPayload[];
  readonly taskStatusEvents: readonly TaskStatusEvent[];
  readonly wakeUpJobs: readonly WorkflowRuntimeWakeUpJobPayload[];
};

export type SettleWorkerCompletionCommand = {
  readonly attempt: number;
  readonly providerCostCredits: number;
  readonly generatedAsset: WorkflowRuntimeGeneratedPrimaryAssetPayload;
  readonly ownerUserId: string;
  readonly reviewRequired: boolean;
  readonly taskRunId: string;
  readonly workflowId: string;
};

export type SettleWorkerFailureCommand = {
  readonly attempt: number;
  readonly failureReason: Exclude<
    TaskRunFailureReason,
    { readonly type: "UPSTREAM_FAILED" }
  >;
  readonly failureSource: TaskRunSettlementFailureSource;
  readonly providerCostCredits?: number;
  readonly ownerUserId: string;
  readonly taskRunId: string;
  readonly workflowId: string;
};

export type HandleWakeUpCallCommand = WakeUpTaskRunChildrenRepositoryCommand & {
  readonly workflowId: string;
};

export type ReviewTaskRunDecisionCommand = {
  readonly attempt: number;
  readonly ownerUserId: string;
  readonly taskRunId: string;
  readonly workflowId: string;
};

export type RejectTaskRunCommand = ReviewTaskRunDecisionCommand;

export type RejectTaskRunRepositoryCommand = RejectTaskRunCommand & {
  readonly newTaskRunId: string;
};

export type WorkflowRuntimeSettleCompletionResult =
  | {
      readonly settled: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload | null;
    }
  | { readonly settled: false };

export type WorkflowRuntimeSettleFailureResult =
  | {
      readonly settled: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload;
    }
  | { readonly settled: false };

export type WorkflowRuntimeReviewDecisionResult =
  | {
      readonly decided: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload;
    }
  | { readonly decided: false };

export type TaskRunCancellationBlockedReason =
  | "PENDING_REVIEW_REQUIRES_REVIEW_DECISION"
  | "RUNNING_TASK_RUN_CANCELLATION_BLOCKED";

export type WorkflowRuntimeCancelTaskRunResult =
  | WorkflowRuntimeReviewDecisionResult
  | {
      readonly blocked: true;
      readonly decided: false;
      readonly message: string;
      readonly reason: TaskRunCancellationBlockedReason;
    };

export type WorkflowRuntimeRejectTaskRunResult =
  | {
      readonly rejected: true;
      readonly executionJob: WorkflowRuntimeExecutionJobPayload | null;
      readonly taskStatusEvents: readonly TaskStatusEvent[];
    }
  | { readonly rejected: false };

export type WorkflowRuntimeRepositoryForCommands = {
  readonly commitWorkflowRunPlan: (
    plan: WorkflowRunPlan,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<WorkflowRuntimeCommitPlanResult>,
    WorkflowRuntimeRepositoryFailure
  >;
  readonly settleTaskRunCompletion: (
    command: SettleWorkerCompletionCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<WorkflowRuntimeSettleCompletionResult>,
    WorkflowRuntimeRepositoryFailure
  >;
  readonly settleTaskRunFailure: (
    command: SettleWorkerFailureCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<WorkflowRuntimeSettleFailureResult>,
    WorkflowRuntimeRepositoryFailure
  >;
  readonly approveTaskRun: (
    command: ReviewTaskRunDecisionCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<WorkflowRuntimeReviewDecisionResult>,
    WorkflowRuntimeRepositoryFailure
  >;
  readonly cancelTaskRun: (
    command: ReviewTaskRunDecisionCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<WorkflowRuntimeCancelTaskRunResult>,
    WorkflowRuntimeRepositoryFailure
  >;
  readonly rejectTaskRunAndCreateRegeneration: (
    command: RejectTaskRunRepositoryCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<WorkflowRuntimeRejectTaskRunResult>,
    WorkflowRuntimeRepositoryFailure
  >;
  readonly wakeUpTaskRunChildren: (
    command: HandleWakeUpCallCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<WakeUpTaskRunChildrenRepositoryResult>,
    WorkflowRuntimeRepositoryFailure
  >;
};

export type WorkflowRuntimeQueueForCommands = {
  readonly enqueueExecutionJob: (
    job: WorkflowRuntimeExecutionJobPayload,
  ) => Effect.Effect<void, unknown>;
  readonly enqueueWakeUpJob: (
    job: WorkflowRuntimeWakeUpJobPayload,
  ) => Effect.Effect<void, unknown>;
};

export type WorkflowRuntimeEventPublisherForCommands = {
  readonly publishTaskStatusEvent: (
    workflowId: string,
    event: TaskStatusEvent,
  ) => Effect.Effect<void, unknown>;
};
