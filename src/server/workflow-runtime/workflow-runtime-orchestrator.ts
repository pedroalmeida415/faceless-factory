import { randomUUID } from "node:crypto";
import type { GeneratedAsset } from "~/lib/workflow-runtime/assets/generated-asset-projection";
import type { TaskRunFailureReason } from "~/lib/workflow-runtime/domain/task-run-state";
import {
  planWorkflowRun,
  type WorkflowRunPlan,
  type WorkflowRunPlannerError,
  type WorkflowRunPlannerInput,
} from "~/lib/workflow-runtime/planning/workflow-run-planner";
import type { TaskStatusEvent } from "~/lib/workflow-runtime/runtime/task-status-events";
import type {
  WakeUpTaskRunChildrenRepositoryCommand,
  WakeUpTaskRunChildrenRepositoryResult,
} from "~/server/workflow-runtime/workflow-runtime-gatekeeper-repository";
import type {
  WorkflowRuntimeExecutionJobPayload,
  WorkflowRuntimeWakeUpJobPayload,
} from "~/server/workflow-runtime/workflow-runtime-queue";

export type StartWorkflowRunInput = Omit<
  WorkflowRunPlannerInput,
  "createNodeExecutionId" | "createTaskRunId"
>;

export type WorkflowRuntimeCommitPlanResult = {
  readonly executionJobs: readonly WorkflowRuntimeExecutionJobPayload[];
  readonly taskStatusEvents: readonly TaskStatusEvent[];
  readonly wakeUpJobs: readonly WorkflowRuntimeWakeUpJobPayload[];
};

type GeneratedPrimaryAssetInput = GeneratedAsset & {
  readonly contentType: string;
  readonly externalUri?: string | null;
  readonly fileName: string;
  readonly model?: string | null;
  readonly sizeBytes: number;
  readonly storageKey?: string | null;
  readonly storageProvider: string;
};

export type SettleWorkerCompletionCommand = {
  readonly attempt: number;
  readonly finalCostCredits: number;
  readonly generatedAsset: GeneratedPrimaryAssetInput;
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
  readonly finalCostCredits?: number;
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
  ) => Promise<WorkflowRuntimeCommitPlanResult>;
  readonly settleTaskRunCompletion: (
    command: SettleWorkerCompletionCommand,
  ) => Promise<WorkflowRuntimeSettleCompletionResult>;
  readonly settleTaskRunFailure: (
    command: SettleWorkerFailureCommand,
  ) => Promise<WorkflowRuntimeSettleFailureResult>;
  readonly approveTaskRun: (
    command: ReviewTaskRunDecisionCommand,
  ) => Promise<WorkflowRuntimeReviewDecisionResult>;
  readonly cancelTaskRun: (
    command: ReviewTaskRunDecisionCommand,
  ) => Promise<WorkflowRuntimeReviewDecisionResult>;
  readonly rejectTaskRunAndCreateRegeneration: (
    command: RejectTaskRunRepositoryCommand,
  ) => Promise<WorkflowRuntimeRejectTaskRunResult>;
  readonly wakeUpTaskRunChildren: (
    command: WakeUpTaskRunChildrenRepositoryCommand,
  ) => Promise<WakeUpTaskRunChildrenRepositoryResult>;
};

export type WorkflowRuntimeQueueForOrchestrator = {
  readonly enqueueExecutionJobs: (
    jobs: readonly WorkflowRuntimeExecutionJobPayload[],
  ) => Promise<void>;
  readonly enqueueWakeUpJobs: (
    jobs: readonly WorkflowRuntimeWakeUpJobPayload[],
  ) => Promise<void>;
};

export type WorkflowRuntimeEventPublisherForOrchestrator = {
  readonly publishTaskStatusEvents: (
    workflowId: string,
    events: readonly TaskStatusEvent[],
  ) => Promise<void>;
};

export type WorkflowRuntimeOrchestratorError =
  | (WorkflowRunPlannerError & { readonly committed: false })
  | {
      readonly _tag: "WorkflowRuntimeCommitError";
      readonly cause: unknown;
      readonly committed: false;
      readonly message: string;
    }
  | {
      readonly _tag: "WorkflowRuntimePostCommitSideEffectError";
      readonly cause: unknown;
      readonly committed: true;
      readonly message: string;
      readonly sideEffect:
        | "enqueue-execution-jobs"
        | "enqueue-wake-up-jobs"
        | "publish-task-status-events";
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

      const committed = await input.repository
        .commitWorkflowRunPlan(planning.value)
        .then(
          (value) => ({ ok: true, value }) as const,
          (cause: unknown) =>
            ({
              error: {
                _tag: "WorkflowRuntimeCommitError",
                cause,
                committed: false,
                message: "Failed to commit Workflow Run plan.",
              },
              ok: false,
            }) as const,
        );
      if (!committed.ok) {
        return committed;
      }

      const enqueued = await input.queue
        .enqueueExecutionJobs(committed.value.executionJobs)
        .then(
          () => ({ ok: true }) as const,
          (cause: unknown) => postCommitError("enqueue-execution-jobs", cause),
        );
      if (!enqueued.ok) {
        return enqueued;
      }

      const wakeUpsEnqueued = await input.queue
        .enqueueWakeUpJobs(committed.value.wakeUpJobs)
        .then(
          () => ({ ok: true }) as const,
          (cause: unknown) => postCommitError("enqueue-wake-up-jobs", cause),
        );
      if (!wakeUpsEnqueued.ok) {
        return wakeUpsEnqueued;
      }

      const published = await input.eventPublisher
        .publishTaskStatusEvents(
          startInput.workflowId,
          committed.value.taskStatusEvents,
        )
        .then(
          () => ({ ok: true }) as const,
          (cause: unknown) =>
            postCommitError("publish-task-status-events", cause),
        );
      if (!published.ok) {
        return published;
      }

      return { ok: true, value: committed.value };
    },

    async settleWorkerCompletion(
      command: SettleWorkerCompletionCommand,
    ): Promise<SettleWorkerCompletionResult> {
      const settled = await input.repository.settleTaskRunCompletion(command);
      if (!settled.settled) {
        return { ok: true, value: settled };
      }

      const enqueued = await enqueueWakeUpJobs(
        input.queue,
        settled.wakeUpJob ? [settled.wakeUpJob] : [],
      );
      if (!enqueued.ok) {
        return enqueued;
      }

      const published = await publishTaskStatusEvents(
        input.eventPublisher,
        command.workflowId,
        [settled.event],
      );
      if (!published.ok) {
        return published;
      }

      return { ok: true, value: settled };
    },

    async settleWorkerFailure(
      command: SettleWorkerFailureCommand,
    ): Promise<SettleWorkerFailureResult> {
      const settled = await input.repository.settleTaskRunFailure(command);
      if (!settled.settled) {
        return { ok: true, value: settled };
      }

      const enqueued = await enqueueWakeUpJobs(input.queue, [
        settled.wakeUpJob,
      ]);
      if (!enqueued.ok) {
        return enqueued;
      }

      const published = await publishTaskStatusEvents(
        input.eventPublisher,
        command.workflowId,
        [settled.event],
      );
      if (!published.ok) {
        return published;
      }

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
    ): Promise<ReviewTaskRunDecisionResult> {
      return handleReviewDecision(
        () => input.repository.cancelTaskRun(command),
        input.queue,
        input.eventPublisher,
        command.workflowId,
      );
    },

    async rejectTaskRun(
      command: RejectTaskRunCommand,
    ): Promise<RejectTaskRunResult> {
      const committed = await input.repository
        .rejectTaskRunAndCreateRegeneration({
          ...command,
          newTaskRunId: createTaskRunId(),
        })
        .then(
          (value) => ({ ok: true, value }) as const,
          (cause: unknown) =>
            ({
              error: {
                _tag: "WorkflowRuntimeCommitError",
                cause,
                committed: false,
                message: "Failed to reject Task Run.",
              },
              ok: false,
            }) as const,
        );
      if (!committed.ok) {
        return committed;
      }
      if (!committed.value.rejected) {
        return { ok: true, value: committed.value };
      }

      const enqueued = await enqueueExecutionJobs(
        input.queue,
        committed.value.executionJob ? [committed.value.executionJob] : [],
      );
      if (!enqueued.ok) {
        return enqueued;
      }

      const published = await publishTaskStatusEvents(
        input.eventPublisher,
        command.workflowId,
        committed.value.taskStatusEvents,
      );
      if (!published.ok) {
        return published;
      }

      return { ok: true, value: committed.value };
    },

    async handleWakeUpCall(
      command: HandleWakeUpCallCommand,
    ): Promise<HandleWakeUpCallResult> {
      const committed = await input.repository
        .wakeUpTaskRunChildren(command)
        .then(
          (value) => ({ ok: true, value }) as const,
          (cause: unknown) =>
            ({
              error: {
                _tag: "WorkflowRuntimeCommitError",
                cause,
                committed: false,
                message: "Failed to handle Wake-Up Call.",
              },
              ok: false,
            }) as const,
        );
      if (!committed.ok) {
        return committed;
      }

      const enqueued = await enqueueExecutionJobs(
        input.queue,
        committed.value.executionJobs,
      );
      if (!enqueued.ok) {
        return enqueued;
      }

      const published = await publishTaskStatusEvents(
        input.eventPublisher,
        command.workflowId,
        committed.value.taskStatusEvents,
      );
      if (!published.ok) {
        return published;
      }

      return { ok: true, value: committed.value };
    },
  };
}

async function handleReviewDecision(
  decide: () => Promise<WorkflowRuntimeReviewDecisionResult>,
  queue: WorkflowRuntimeQueueForOrchestrator,
  eventPublisher: WorkflowRuntimeEventPublisherForOrchestrator,
  workflowId: string,
): Promise<ReviewTaskRunDecisionResult> {
  const decided = await decide();
  if (!decided.decided) {
    return { ok: true, value: decided };
  }

  const enqueued = await enqueueWakeUpJobs(queue, [decided.wakeUpJob]);
  if (!enqueued.ok) {
    return enqueued;
  }

  const published = await publishTaskStatusEvents(eventPublisher, workflowId, [
    decided.event,
  ]);
  if (!published.ok) {
    return published;
  }

  return { ok: true, value: decided };
}

function enqueueExecutionJobs(
  queue: WorkflowRuntimeQueueForOrchestrator,
  jobs: readonly WorkflowRuntimeExecutionJobPayload[],
) {
  if (jobs.length === 0) {
    return Promise.resolve({ ok: true } as const);
  }

  return queue.enqueueExecutionJobs(jobs).then(
    () => ({ ok: true }) as const,
    (cause: unknown) => postCommitError("enqueue-execution-jobs", cause),
  );
}

function enqueueWakeUpJobs(
  queue: WorkflowRuntimeQueueForOrchestrator,
  jobs: readonly WorkflowRuntimeWakeUpJobPayload[],
) {
  if (jobs.length === 0) {
    return Promise.resolve({ ok: true } as const);
  }

  return queue.enqueueWakeUpJobs(jobs).then(
    () => ({ ok: true }) as const,
    (cause: unknown) => postCommitError("enqueue-wake-up-jobs", cause),
  );
}

function publishTaskStatusEvents(
  eventPublisher: WorkflowRuntimeEventPublisherForOrchestrator,
  workflowId: string,
  events: readonly TaskStatusEvent[],
) {
  if (events.length === 0) {
    return Promise.resolve({ ok: true } as const);
  }

  return eventPublisher.publishTaskStatusEvents(workflowId, events).then(
    () => ({ ok: true }) as const,
    (cause: unknown) => postCommitError("publish-task-status-events", cause),
  );
}

function postCommitError(
  sideEffect:
    | "enqueue-execution-jobs"
    | "enqueue-wake-up-jobs"
    | "publish-task-status-events",
  cause: unknown,
): { readonly ok: false; readonly error: WorkflowRuntimeOrchestratorError } {
  return {
    error: {
      _tag: "WorkflowRuntimePostCommitSideEffectError",
      cause,
      committed: true,
      message: `Failed to ${sideEffect}.`,
      sideEffect,
    },
    ok: false,
  } as const;
}
