import { randomUUID } from "node:crypto";
import { Effect, Either } from "effect";
import type {
  TaskRunFailureReason,
  TaskRunSettlementFailureSource,
} from "~/lib/workflow-runtime/domain/task-run-state";
import {
  planWorkflowRun,
  type WorkflowRunPlan,
  type WorkflowRunPlannerError,
  type WorkflowRunPlannerInput,
} from "~/lib/workflow-runtime/planning/workflow-run-planner";
import type { TaskStatusEvent } from "~/lib/workflow-runtime/runtime/task-status-events";
import {
  deliverPostCommitWorkBestEffort,
  type PostCommitWork,
} from "~/server/workflow-runtime/workflow-runtime-post-commit-work";
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

export type WorkflowRuntimeRepositoryForOrchestrator = {
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

export type WorkflowRuntimeQueueForOrchestrator = {
  readonly enqueueExecutionJob?: (
    job: WorkflowRuntimeExecutionJobPayload,
  ) => Effect.Effect<void, unknown>;
  readonly enqueueExecutionJobs: (
    jobs: readonly WorkflowRuntimeExecutionJobPayload[],
  ) => Promise<void>;
  readonly enqueueWakeUpJob?: (
    job: WorkflowRuntimeWakeUpJobPayload,
  ) => Effect.Effect<void, unknown>;
  readonly enqueueWakeUpJobs: (
    jobs: readonly WorkflowRuntimeWakeUpJobPayload[],
  ) => Promise<void>;
};

export type WorkflowRuntimeEventPublisherForOrchestrator = {
  readonly publishTaskStatusEvent?: (
    workflowId: string,
    event: TaskStatusEvent,
  ) => Effect.Effect<void, unknown>;
  readonly publishTaskStatusEvents: (
    workflowId: string,
    events: readonly TaskStatusEvent[],
  ) => Promise<void>;
};

export type WorkflowRuntimeOrchestratorError =
  | (WorkflowRunPlannerError & { readonly committed: false })
  | {
      readonly _tag: "TaskRunCancellationBlockedError";
      readonly committed: false;
      readonly message: string;
      readonly reason: TaskRunCancellationBlockedReason;
    }
  | {
      readonly _tag: "WorkflowRuntimeCommitError";
      readonly cause: unknown;
      readonly committed: false;
      readonly message: string;
    };

export type StartWorkflowRunResult =
  | { readonly ok: true; readonly value: WorkflowRuntimeCommitPlanResult }
  | { readonly ok: false; readonly error: WorkflowRuntimeOrchestratorError };

export type SettleWorkerCompletionResult =
  | { readonly ok: true; readonly value: WorkflowRuntimeSettleCompletionResult }
  | { readonly ok: false; readonly error: WorkflowRuntimeOrchestratorError };

export type SettleWorkerFailureResult =
  | { readonly ok: true; readonly value: WorkflowRuntimeSettleFailureResult }
  | { readonly ok: false; readonly error: WorkflowRuntimeOrchestratorError };

export type HandleWakeUpCallResult =
  | { readonly ok: true; readonly value: WakeUpTaskRunChildrenRepositoryResult }
  | { readonly ok: false; readonly error: WorkflowRuntimeOrchestratorError };

export type ReviewTaskRunDecisionResult =
  | { readonly ok: true; readonly value: WorkflowRuntimeReviewDecisionResult }
  | { readonly ok: false; readonly error: WorkflowRuntimeOrchestratorError };

export type CancelTaskRunResult =
  | { readonly ok: true; readonly value: WorkflowRuntimeReviewDecisionResult }
  | { readonly ok: false; readonly error: WorkflowRuntimeOrchestratorError };

export type RejectTaskRunResult =
  | { readonly ok: true; readonly value: WorkflowRuntimeRejectTaskRunResult }
  | { readonly ok: false; readonly error: WorkflowRuntimeOrchestratorError };

export function createWorkflowRuntimeOrchestrator(input: {
  readonly createNodeExecutionId?: () => string;
  readonly createTaskRunId?: () => string;
  readonly eventPublisher: WorkflowRuntimeEventPublisherForOrchestrator;
  readonly queue: WorkflowRuntimeQueueForOrchestrator;
  readonly repository: WorkflowRuntimeRepositoryForOrchestrator;
}) {
  const createNodeExecutionId = input.createNodeExecutionId ?? randomUUID;
  const createTaskRunId = input.createTaskRunId ?? randomUUID;

  return {
    async startWorkflowRun(
      startInput: StartWorkflowRunInput,
    ): Promise<StartWorkflowRunResult> {
      const planning = planWorkflowRun({
        ...startInput,
        createNodeExecutionId,
        createTaskRunId,
      });
      if (!planning.ok) {
        return {
          error: { ...planning.error, committed: false },
          ok: false,
        };
      }

      const committed = await runRepositoryEffectResult(
        input.repository.commitWorkflowRunPlan(planning.value),
        "Failed to commit Workflow Run plan.",
      );
      if (!committed.ok) {
        return committed;
      }

      await runPostCommitDelivery(
        input.queue,
        input.eventPublisher,
        committed.value.postCommitWork,
      );

      return { ok: true, value: committed.value.value };
    },

    async settleWorkerCompletion(
      command: SettleWorkerCompletionCommand,
    ): Promise<SettleWorkerCompletionResult> {
      const outcome = await runRepositoryEffectResult(
        input.repository.settleTaskRunCompletion(command),
        "Failed to settle completed Task Run.",
        (error) =>
          error._tag === "StaleTaskRunTransition"
            ? emptyOutcome({ settled: false as const }, command.workflowId)
            : null,
      );
      if (!outcome.ok) {
        return outcome;
      }
      const settled = outcome.value.value;
      if (!settled.settled) {
        return { ok: true, value: settled };
      }

      await runPostCommitDelivery(
        input.queue,
        input.eventPublisher,
        outcome.value.postCommitWork,
      );

      return { ok: true, value: settled };
    },

    async settleWorkerFailure(
      command: SettleWorkerFailureCommand,
    ): Promise<SettleWorkerFailureResult> {
      const outcome = await runRepositoryEffectResult(
        input.repository.settleTaskRunFailure(command),
        "Failed to settle failed Task Run.",
        (error) =>
          error._tag === "StaleTaskRunTransition"
            ? emptyOutcome({ settled: false as const }, command.workflowId)
            : null,
      );
      if (!outcome.ok) {
        return outcome;
      }
      const settled = outcome.value.value;
      if (!settled.settled) {
        return { ok: true, value: settled };
      }

      await runPostCommitDelivery(
        input.queue,
        input.eventPublisher,
        outcome.value.postCommitWork,
      );

      return { ok: true, value: settled };
    },

    async approveTaskRun(
      command: ReviewTaskRunDecisionCommand,
    ): Promise<ReviewTaskRunDecisionResult> {
      return handleReviewDecision(
        () => input.repository.approveTaskRun(command),
        input.queue,
        input.eventPublisher,
        command.workflowId,
      );
    },

    async cancelTaskRun(
      command: ReviewTaskRunDecisionCommand,
    ): Promise<CancelTaskRunResult> {
      const outcome = await runRepositoryEffectResult(
        input.repository.cancelTaskRun(command),
        "Failed to cancel Task Run.",
        (error) =>
          error._tag === "StaleTaskRunTransition"
            ? emptyOutcome({ decided: false as const }, command.workflowId)
            : null,
      );
      if (!outcome.ok) {
        return outcome;
      }
      const decided = outcome.value.value;
      if ("blocked" in decided) {
        return {
          error: {
            _tag: "TaskRunCancellationBlockedError",
            committed: false,
            message: decided.message,
            reason: decided.reason,
          },
          ok: false,
        };
      }

      return handleCommittedReviewDecision(
        outcome.value,
        input.queue,
        input.eventPublisher,
      );
    },

    async rejectTaskRun(
      command: RejectTaskRunCommand,
    ): Promise<RejectTaskRunResult> {
      const committed = await runRepositoryEffectResult(
        input.repository.rejectTaskRunAndCreateRegeneration({
          ...command,
          newTaskRunId: createTaskRunId(),
        }),
        "Failed to reject Task Run.",
        (error) =>
          error._tag === "StaleTaskRunTransition"
            ? emptyOutcome({ rejected: false as const }, command.workflowId)
            : null,
      );
      if (!committed.ok) {
        return committed;
      }
      if (!committed.value.value.rejected) {
        return { ok: true, value: committed.value.value };
      }

      await runPostCommitDelivery(
        input.queue,
        input.eventPublisher,
        committed.value.postCommitWork,
      );

      return { ok: true, value: committed.value.value };
    },

    async handleWakeUpCall(
      command: HandleWakeUpCallCommand,
    ): Promise<HandleWakeUpCallResult> {
      const committed = await runRepositoryEffectResult(
        input.repository.wakeUpTaskRunChildren(command),
        "Failed to handle Wake-Up Call.",
        (error) =>
          error._tag === "WakeUpParentNotFound"
            ? emptyOutcome(
                {
                  executionJobs: [],
                  parentFound: false as const,
                  taskStatusEvents: [],
                },
                command.workflowId,
              )
            : null,
      );
      if (!committed.ok) {
        return committed;
      }

      await runPostCommitDelivery(
        input.queue,
        input.eventPublisher,
        committed.value.postCommitWork,
      );

      return { ok: true, value: committed.value.value };
    },
  };
}

async function handleReviewDecision(
  decide: () => ReturnType<
    WorkflowRuntimeRepositoryForOrchestrator["approveTaskRun"]
  >,
  queue: WorkflowRuntimeQueueForOrchestrator,
  eventPublisher: WorkflowRuntimeEventPublisherForOrchestrator,
  workflowId: string,
): Promise<ReviewTaskRunDecisionResult> {
  const outcome = await runRepositoryEffectResult(
    decide(),
    "Failed to decide Task Run review.",
    (error) =>
      error._tag === "StaleTaskRunTransition"
        ? emptyOutcome({ decided: false as const }, workflowId)
        : null,
  );
  return outcome.ok
    ? handleCommittedReviewDecision(outcome.value, queue, eventPublisher)
    : outcome;
}

async function handleCommittedReviewDecision(
  outcome: RepositoryCommittedOutcome<WorkflowRuntimeReviewDecisionResult>,
  queue: WorkflowRuntimeQueueForOrchestrator,
  eventPublisher: WorkflowRuntimeEventPublisherForOrchestrator,
): Promise<ReviewTaskRunDecisionResult> {
  const decided = outcome.value;
  if (!decided.decided) {
    return { ok: true, value: decided };
  }

  await runPostCommitDelivery(queue, eventPublisher, outcome.postCommitWork);

  return { ok: true, value: decided };
}

function runPostCommitDelivery(
  queue: WorkflowRuntimeQueueForOrchestrator,
  eventPublisher: WorkflowRuntimeEventPublisherForOrchestrator,
  work: PostCommitWork,
) {
  return Effect.runPromise(
    deliverPostCommitWorkBestEffort(work, { eventPublisher, queue }),
  );
}

async function runRepositoryEffectResult<A, B = A>(
  effect: Effect.Effect<A, WorkflowRuntimeRepositoryFailure>,
  message: string,
  recover?: (error: WorkflowRuntimeRepositoryFailure) => B | null,
) {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(result)) {
    const recovered = recover?.(result.left) ?? null;
    if (recovered) {
      return { ok: true, value: recovered } as const;
    }
  }
  return Either.isRight(result)
    ? ({ ok: true, value: result.right } as const)
    : ({
        error: {
          _tag: "WorkflowRuntimeCommitError",
          cause: result.left,
          committed: false,
          message,
        },
        ok: false,
      } as const);
}

function emptyOutcome<T>(
  value: T,
  workflowId: string,
): RepositoryCommittedOutcome<T> {
  return {
    postCommitWork: {
      executionJobs: [],
      source: "start-workflow-run",
      taskStatusEvents: [],
      wakeUpJobs: [],
      workflowId,
    },
    value,
  };
}
