import type { Effect } from "effect";
import type {
  TaskFailureReason,
  TaskSettlementFailureSource,
} from "~/features/runtime/domain/task-state";
import type { TaskStatusEvent } from "~/features/runtime/events/task-status-events";
import type {
  WorkflowRunPlan,
  WorkflowRunPlannerInput,
} from "~/features/runtime/planning/workflow-run-planner";
import type {
  RepositoryCommittedOutcome,
  RuntimeRepositoryFailure,
  WakeUpTaskChildrenRepositoryCommand,
  WakeUpTaskChildrenRepositoryResult,
} from "~/features/runtime/server/repository";
import type {
  QueueServiceApi,
  RuntimeExecutionJobPayload,
  RuntimeGeneratedPrimaryAssetPayload,
  RuntimeWakeUpJobPayload,
} from "~/server/services/queue";

export type StartWorkflowRunInput = Omit<
  WorkflowRunPlannerInput,
  "createNodeRunId" | "createTaskId"
>;

export type RuntimeCommitPlanResult = {
  readonly executionJobs: readonly RuntimeExecutionJobPayload[];
  readonly taskStatusEvents: readonly TaskStatusEvent[];
  readonly wakeUpJobs: readonly RuntimeWakeUpJobPayload[];
};

export type SettleWorkerCompletionCommand = {
  readonly providerCostCredits: number;
  readonly generatedAsset: RuntimeGeneratedPrimaryAssetPayload;
  readonly ownerUserId: string;
  readonly reviewRequired: boolean;
  readonly taskId: string;
  readonly workflowId: string;
};

export type SettleWorkerFailureCommand = {
  readonly failureReason: Exclude<
    TaskFailureReason,
    { readonly type: "UPSTREAM_FAILED" }
  >;
  readonly failureSource: TaskSettlementFailureSource;
  readonly providerCostCredits?: number;
  readonly ownerUserId: string;
  readonly taskId: string;
  readonly workflowId: string;
};

export type HandleWakeUpCallCommand = WakeUpTaskChildrenRepositoryCommand & {
  readonly workflowId: string;
};

export type ReviewTaskDecisionCommand = {
  readonly ownerUserId: string;
  readonly taskId: string;
  readonly workflowId: string;
};

export type RejectTaskCommand = ReviewTaskDecisionCommand;

export type RejectTaskRepositoryCommand = RejectTaskCommand & {
  readonly newTaskId: string;
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

export type TaskCancellationBlockedReason =
  | "PENDING_REVIEW_REQUIRES_REVIEW_DECISION"
  | "RUNNING_TASK_RUN_CANCELLATION_BLOCKED";

export type RuntimeCancelTaskResult =
  | RuntimeReviewDecisionResult
  | {
      readonly blocked: true;
      readonly decided: false;
      readonly message: string;
      readonly reason: TaskCancellationBlockedReason;
    };

export type RuntimeRejectTaskResult =
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
  readonly settleTaskCompletion: (
    command: SettleWorkerCompletionCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<RuntimeSettleCompletionResult>,
    RuntimeRepositoryFailure
  >;
  readonly settleTaskFailure: (
    command: SettleWorkerFailureCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<RuntimeSettleFailureResult>,
    RuntimeRepositoryFailure
  >;
  readonly approveTask: (
    command: ReviewTaskDecisionCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<RuntimeReviewDecisionResult>,
    RuntimeRepositoryFailure
  >;
  readonly cancelTask: (
    command: ReviewTaskDecisionCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<RuntimeCancelTaskResult>,
    RuntimeRepositoryFailure
  >;
  readonly rejectTaskAndCreateRegeneration: (
    command: RejectTaskRepositoryCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<RuntimeRejectTaskResult>,
    RuntimeRepositoryFailure
  >;
  readonly wakeUpTaskChildren: (
    command: HandleWakeUpCallCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<WakeUpTaskChildrenRepositoryResult>,
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
