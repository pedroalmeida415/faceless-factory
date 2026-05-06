import { randomUUID } from "node:crypto";
import { Context, Effect, Layer } from "effect";
import {
  planWorkflowRun,
  type WorkflowRunPlannerError,
} from "~/lib/workflow-runtime/planning/workflow-run-planner";
import type { TaskStatusEvent } from "~/lib/workflow-runtime/runtime/task-status-events";
import {
  committed,
  ignored,
  type WorkflowRuntimeCommandOutcome,
} from "~/server/workflow-runtime/workflow-runtime-command-outcome";
import type {
  HandleWakeUpCallCommand,
  RejectTaskRunCommand,
  RejectTaskRunRepositoryCommand,
  ReviewTaskRunDecisionCommand,
  SettleWorkerCompletionCommand,
  SettleWorkerFailureCommand,
  StartWorkflowRunInput,
  TaskRunCancellationBlockedReason,
  WorkflowRuntimeCommitPlanResult,
  WorkflowRuntimeEventPublisherForOrchestrator,
  WorkflowRuntimeQueueForOrchestrator,
  WorkflowRuntimeRejectTaskRunResult,
  WorkflowRuntimeRepositoryForOrchestrator,
  WorkflowRuntimeReviewDecisionResult,
  WorkflowRuntimeSettleCompletionResult,
  WorkflowRuntimeSettleFailureResult,
} from "~/server/workflow-runtime/workflow-runtime-orchestrator";
import type {
  WorkflowRuntimeExecutionJobPayload,
  WorkflowRuntimeWakeUpJobPayload,
} from "~/server/workflow-runtime/workflow-runtime-queue";

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

export class WorkflowRuntimeRepository extends Context.Tag(
  "WorkflowRuntimeRepository",
)<WorkflowRuntimeRepository, WorkflowRuntimeRepositoryForOrchestrator>() {}

export class WorkflowRuntimeQueue extends Context.Tag("WorkflowRuntimeQueue")<
  WorkflowRuntimeQueue,
  WorkflowRuntimeQueueForOrchestrator
>() {}

export class WorkflowRuntimeEventPublisher extends Context.Tag(
  "WorkflowRuntimeEventPublisher",
)<
  WorkflowRuntimeEventPublisher,
  WorkflowRuntimeEventPublisherForOrchestrator
>() {}

export class WorkflowRuntimeIdGenerator extends Context.Tag(
  "WorkflowRuntimeIdGenerator",
)<
  WorkflowRuntimeIdGenerator,
  {
    readonly createNodeExecutionId: () => string;
    readonly createTaskRunId: () => string;
  }
>() {
  static readonly Live = Layer.succeed(this, {
    createNodeExecutionId: randomUUID,
    createTaskRunId: randomUUID,
  });
}

export class WorkflowRuntimeCommands extends Context.Tag(
  "WorkflowRuntimeCommands",
)<
  WorkflowRuntimeCommands,
  {
    readonly approveTaskRun: (
      command: ReviewTaskRunDecisionCommand,
    ) => Effect.Effect<
      WorkflowRuntimeCommandOutcome<WorkflowRuntimeReviewDecisionResult>,
      WorkflowRuntimeOrchestratorError
    >;
    readonly cancelTaskRun: (
      command: ReviewTaskRunDecisionCommand,
    ) => Effect.Effect<
      WorkflowRuntimeCommandOutcome<WorkflowRuntimeReviewDecisionResult>,
      WorkflowRuntimeOrchestratorError
    >;
    readonly handleWakeUpCall: (
      command: HandleWakeUpCallCommand,
    ) => Effect.Effect<
      WorkflowRuntimeCommandOutcome<WakeUpTaskRunChildrenRepositoryResult>,
      WorkflowRuntimeOrchestratorError
    >;
    readonly rejectTaskRun: (
      command: RejectTaskRunCommand,
    ) => Effect.Effect<
      WorkflowRuntimeCommandOutcome<WorkflowRuntimeRejectTaskRunResult>,
      WorkflowRuntimeOrchestratorError
    >;
    readonly settleWorkerCompletion: (
      command: SettleWorkerCompletionCommand,
    ) => Effect.Effect<
      WorkflowRuntimeCommandOutcome<WorkflowRuntimeSettleCompletionResult>,
      WorkflowRuntimeOrchestratorError
    >;
    readonly settleWorkerFailure: (
      command: SettleWorkerFailureCommand,
    ) => Effect.Effect<
      WorkflowRuntimeCommandOutcome<WorkflowRuntimeSettleFailureResult>,
      WorkflowRuntimeOrchestratorError
    >;
    readonly startWorkflowRun: (
      input: StartWorkflowRunInput,
    ) => Effect.Effect<
      WorkflowRuntimeCommandOutcome<WorkflowRuntimeCommitPlanResult>,
      WorkflowRuntimeOrchestratorError
    >;
  }
>() {
  static readonly Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const repository = yield* WorkflowRuntimeRepository;
      const queue = yield* WorkflowRuntimeQueue;
      const eventPublisher = yield* WorkflowRuntimeEventPublisher;
      const ids = yield* WorkflowRuntimeIdGenerator;

      return {
        approveTaskRun: (command) =>
          handleReviewDecision(
            () => repository.approveTaskRun(command),
            queue,
            eventPublisher,
            command.workflowId,
          ),
        cancelTaskRun: (command) =>
          Effect.flatMap(
            tryRepositoryCommit(
              () => repository.cancelTaskRun(command),
              "Failed to cancel Task Run.",
            ),
            (result) =>
              "blocked" in result
                ? Effect.fail({
                    _tag: "TaskRunCancellationBlockedError",
                    committed: false,
                    message: result.message,
                    reason: result.reason,
                  } as const)
                : handleCommittedReviewDecision(
                    result,
                    queue,
                    eventPublisher,
                    command.workflowId,
                  ),
          ),
        handleWakeUpCall: (command) =>
          Effect.gen(function* () {
            const result = yield* tryRepositoryCommit(
              () => repository.wakeUpTaskRunChildren(command),
              "Failed to handle Wake-Up Call.",
            );
            if (result.parentFound === false) {
              return ignored("WAKE_UP_PARENT_NOT_FOUND");
            }
            yield* enqueueExecutionJobs(queue, result.executionJobs);
            yield* publishTaskStatusEvents(
              eventPublisher,
              command.workflowId,
              result.taskStatusEvents,
            );
            return committed(result);
          }),
        rejectTaskRun: (command) =>
          Effect.gen(function* () {
            const result = yield* tryRepositoryCommit(
              () =>
                repository.rejectTaskRunAndCreateRegeneration({
                  ...command,
                  newTaskRunId: ids.createTaskRunId(),
                } satisfies RejectTaskRunRepositoryCommand),
              "Failed to reject Task Run.",
            );
            if (!result.rejected) {
              return ignored("STALE_TASK_RUN");
            }
            yield* enqueueExecutionJobs(
              queue,
              result.executionJob ? [result.executionJob] : [],
            );
            yield* publishTaskStatusEvents(
              eventPublisher,
              command.workflowId,
              result.taskStatusEvents,
            );
            return committed(result);
          }),
        settleWorkerCompletion: (command) =>
          Effect.gen(function* () {
            const result = yield* tryRepositoryCommit(
              () => repository.settleTaskRunCompletion(command),
              "Failed to settle completed Task Run.",
            );
            if (!result.settled) {
              return ignored("STALE_TASK_RUN");
            }
            yield* enqueueWakeUpJobs(
              queue,
              result.wakeUpJob ? [result.wakeUpJob] : [],
            );
            yield* publishTaskStatusEvents(eventPublisher, command.workflowId, [
              result.event,
            ]);
            return committed(result);
          }),
        settleWorkerFailure: (command) =>
          Effect.gen(function* () {
            const result = yield* tryRepositoryCommit(
              () => repository.settleTaskRunFailure(command),
              "Failed to settle failed Task Run.",
            );
            if (!result.settled) {
              return ignored("STALE_TASK_RUN");
            }
            yield* enqueueWakeUpJobs(queue, [result.wakeUpJob]);
            yield* publishTaskStatusEvents(eventPublisher, command.workflowId, [
              result.event,
            ]);
            return committed(result);
          }),
        startWorkflowRun: (startInput) =>
          Effect.gen(function* () {
            const planning = planWorkflowRun({
              ...startInput,
              createNodeExecutionId: ids.createNodeExecutionId,
              createTaskRunId: ids.createTaskRunId,
            });
            if (!planning.ok) {
              return yield* Effect.fail({
                ...planning.error,
                committed: false,
              });
            }

            const result = yield* tryRepositoryCommit(
              () => repository.commitWorkflowRunPlan(planning.value),
              "Failed to commit Workflow Run plan.",
            );
            yield* enqueueExecutionJobs(queue, result.executionJobs);
            yield* enqueueWakeUpJobs(queue, result.wakeUpJobs);
            yield* publishTaskStatusEvents(
              eventPublisher,
              startInput.workflowId,
              result.taskStatusEvents,
            );
            return committed(result);
          }),
      };
    }),
  );
}

export type WorkflowRuntimeCommandsService = Context.Tag.Service<
  typeof WorkflowRuntimeCommands
>;

type WakeUpTaskRunChildrenRepositoryResult = Awaited<
  ReturnType<WorkflowRuntimeRepositoryForOrchestrator["wakeUpTaskRunChildren"]>
>;

function handleReviewDecision(
  decide: () => Promise<WorkflowRuntimeReviewDecisionResult>,
  queue: WorkflowRuntimeQueueForOrchestrator,
  eventPublisher: WorkflowRuntimeEventPublisherForOrchestrator,
  workflowId: string,
) {
  return Effect.flatMap(
    tryRepositoryCommit(decide, "Failed to decide Task Run review."),
    (result) =>
      handleCommittedReviewDecision(result, queue, eventPublisher, workflowId),
  );
}

function handleCommittedReviewDecision(
  result: WorkflowRuntimeReviewDecisionResult,
  queue: WorkflowRuntimeQueueForOrchestrator,
  eventPublisher: WorkflowRuntimeEventPublisherForOrchestrator,
  workflowId: string,
) {
  if (!result.decided) {
    return Effect.succeed(ignored("STALE_TASK_RUN"));
  }

  return Effect.gen(function* () {
    yield* enqueueWakeUpJobs(queue, [result.wakeUpJob]);
    yield* publishTaskStatusEvents(eventPublisher, workflowId, [result.event]);
    return committed(result);
  });
}

function tryRepositoryCommit<T>(
  run: () => Promise<T>,
  message: string,
): Effect.Effect<T, WorkflowRuntimeOrchestratorError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => ({
      _tag: "WorkflowRuntimeCommitError",
      cause,
      committed: false,
      message,
    }),
  });
}

function enqueueExecutionJobs(
  queue: WorkflowRuntimeQueueForOrchestrator,
  jobs: readonly WorkflowRuntimeExecutionJobPayload[],
) {
  return postCommitWork(
    jobs,
    () => queue.enqueueExecutionJobs(jobs),
    "enqueue-execution-jobs",
  );
}

function enqueueWakeUpJobs(
  queue: WorkflowRuntimeQueueForOrchestrator,
  jobs: readonly WorkflowRuntimeWakeUpJobPayload[],
) {
  return postCommitWork(
    jobs,
    () => queue.enqueueWakeUpJobs(jobs),
    "enqueue-wake-up-jobs",
  );
}

function publishTaskStatusEvents(
  eventPublisher: WorkflowRuntimeEventPublisherForOrchestrator,
  workflowId: string,
  events: readonly TaskStatusEvent[],
) {
  return postCommitWork(
    events,
    () => eventPublisher.publishTaskStatusEvents(workflowId, events),
    "publish-task-status-events",
  );
}

function postCommitWork<T>(
  items: readonly T[],
  run: () => Promise<void>,
  sideEffect:
    | "enqueue-execution-jobs"
    | "enqueue-wake-up-jobs"
    | "publish-task-status-events",
) {
  if (items.length === 0) {
    return Effect.void;
  }

  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.logWarning("Workflow Runtime Post-Commit Work delivery failed", {
        cause: errorMessage(cause),
        itemCount: items.length,
        sideEffect,
      }),
    ),
  );
}

function errorMessage(cause: unknown) {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "Unknown Post-Commit Work delivery failure.";
}
