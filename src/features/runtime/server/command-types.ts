import type { Effect } from "effect";
import type {
  TaskRunFailureReason,
  TaskRunSettlementFailureSource,
} from "~/features/runtime/domain/task-run-state";
import type { TaskStatusEvent } from "~/features/runtime/events/task-status-events";
import type {
  WorkflowRunPlan,
  WorkflowRunPlannerInput,
} from "~/features/runtime/planning/workflow-run-planner";
import type {
  RepositoryCommittedOutcome,
  RuntimeRepositoryFailure,
  WakeUpTaskRunChildrenRepositoryCommand,
  WakeUpTaskRunChildrenRepositoryResult,
} from "~/features/runtime/server/repository";
import type {
  QueueServiceApi,
  RuntimeExecutionJobPayload,
  RuntimeGeneratedPrimaryAssetPayload,
  RuntimeWakeUpJobPayload,
} from "~/server/services/queue";

export type StartWorkflowRunInput = Omit<
  WorkflowRunPlannerInput,
  "createNodeExecutionId" | "createTaskRunId"
>;

export type RuntimeCommitPlanResult = {
  readonly executionJobs: readonly RuntimeExecutionJobPayload[];
  readonly taskStatusEvents: readonly TaskStatusEvent[];
  readonly wakeUpJobs: readonly RuntimeWakeUpJobPayload[];
};

export type SettleWorkerCompletionCommand = {
  readonly attempt: number;
  readonly providerCostCredits: number;
  readonly generatedAsset: RuntimeGeneratedPrimaryAssetPayload;
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

export type RuntimeSettleCompletionResult =
  | {
      readonly settled: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: RuntimeWakeUpJobPayload | null;
    }
  | { readonly settled: false };

export type RuntimeSettleFailureResult =
  | {
      readonly settled: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: RuntimeWakeUpJobPayload;
    }
  | { readonly settled: false };

export type RuntimeReviewDecisionResult =
  | {
      readonly decided: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: RuntimeWakeUpJobPayload;
    }
  | { readonly decided: false };

export type TaskRunCancellationBlockedReason =
  | "PENDING_REVIEW_REQUIRES_REVIEW_DECISION"
  | "RUNNING_TASK_RUN_CANCELLATION_BLOCKED";

export type RuntimeCancelTaskRunResult =
  | RuntimeReviewDecisionResult
  | {
      readonly blocked: true;
      readonly decided: false;
      readonly message: string;
      readonly reason: TaskRunCancellationBlockedReason;
    };

export type RuntimeRejectTaskRunResult =
  | {
      readonly rejected: true;
      readonly executionJob: RuntimeExecutionJobPayload | null;
      readonly taskStatusEvents: readonly TaskStatusEvent[];
    }
  | { readonly rejected: false };

export type RuntimeRepositoryForCommands = {
  readonly commitWorkflowRunPlan: (
    plan: WorkflowRunPlan,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<RuntimeCommitPlanResult>,
    RuntimeRepositoryFailure
  >;
  readonly settleTaskRunCompletion: (
    command: SettleWorkerCompletionCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<RuntimeSettleCompletionResult>,
    RuntimeRepositoryFailure
  >;
  readonly settleTaskRunFailure: (
    command: SettleWorkerFailureCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<RuntimeSettleFailureResult>,
    RuntimeRepositoryFailure
  >;
  readonly approveTaskRun: (
    command: ReviewTaskRunDecisionCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<RuntimeReviewDecisionResult>,
    RuntimeRepositoryFailure
  >;
  readonly cancelTaskRun: (
    command: ReviewTaskRunDecisionCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<RuntimeCancelTaskRunResult>,
    RuntimeRepositoryFailure
  >;
  readonly rejectTaskRunAndCreateRegeneration: (
    command: RejectTaskRunRepositoryCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<RuntimeRejectTaskRunResult>,
    RuntimeRepositoryFailure
  >;
  readonly wakeUpTaskRunChildren: (
    command: HandleWakeUpCallCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<WakeUpTaskRunChildrenRepositoryResult>,
    RuntimeRepositoryFailure
  >;
};

export type QueueServiceForCommands = QueueServiceApi;

export type EventPublisherServiceForCommands = {
  readonly publishTaskStatusEvent: (
    workflowId: string,
    event: TaskStatusEvent,
  ) => Effect.Effect<void, unknown>;
};
