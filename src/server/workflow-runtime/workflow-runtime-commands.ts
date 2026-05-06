import { randomUUID } from "node:crypto";
import { Context, Effect, Layer } from "effect";
import {
  planWorkflowRun,
  type WorkflowRunPlannerError,
} from "~/lib/workflow-runtime/planning/workflow-run-planner";
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
import {
  type PostCommitWork,
  type PostCommitWorkSource,
  WorkflowRuntimePostCommitWork,
} from "~/server/workflow-runtime/workflow-runtime-post-commit-work";

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
      const ids = yield* WorkflowRuntimeIdGenerator;
      const postCommit = yield* WorkflowRuntimePostCommitWork;

      return {
        approveTaskRun: (command) =>
          handleReviewDecision(
            () => repository.approveTaskRun(command),
            command.workflowId,
            postCommit,
            "approve-task-run",
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
                    command.workflowId,
                    postCommit,
                    "cancel-task-run",
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
            yield* postCommit.deliver(
              postCommitWork({
                executionJobs: result.executionJobs,
                source: "handle-wake-up-call",
                taskStatusEvents: result.taskStatusEvents,
                workflowId: command.workflowId,
              }),
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
            yield* postCommit.deliver(
              postCommitWork({
                executionJobs: result.executionJob ? [result.executionJob] : [],
                source: "reject-task-run",
                taskStatusEvents: result.taskStatusEvents,
                workflowId: command.workflowId,
              }),
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
            yield* postCommit.deliver(
              postCommitWork({
                source: "settle-worker-completion",
                taskStatusEvents: [result.event],
                wakeUpJobs: result.wakeUpJob ? [result.wakeUpJob] : [],
                workflowId: command.workflowId,
              }),
            );
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
            yield* postCommit.deliver(
              postCommitWork({
                source: "settle-worker-failure",
                taskStatusEvents: [result.event],
                wakeUpJobs: [result.wakeUpJob],
                workflowId: command.workflowId,
              }),
            );
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
                committed: false as const,
              });
            }

            const result = yield* tryRepositoryCommit(
              () => repository.commitWorkflowRunPlan(planning.value),
              "Failed to commit Workflow Run plan.",
            );
            yield* postCommit.deliver(
              postCommitWork({
                executionJobs: result.executionJobs,
                source: "start-workflow-run",
                taskStatusEvents: result.taskStatusEvents,
                wakeUpJobs: result.wakeUpJobs,
                workflowId: startInput.workflowId,
              }),
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
  workflowId: string,
  postCommit: Context.Tag.Service<typeof WorkflowRuntimePostCommitWork>,
  source: PostCommitWorkSource,
): Effect.Effect<
  WorkflowRuntimeCommandOutcome<WorkflowRuntimeReviewDecisionResult>,
  WorkflowRuntimeOrchestratorError
> {
  return Effect.flatMap(
    tryRepositoryCommit(decide, "Failed to decide Task Run review."),
    (result) =>
      handleCommittedReviewDecision(result, workflowId, postCommit, source),
  );
}

function handleCommittedReviewDecision(
  result: WorkflowRuntimeReviewDecisionResult,
  workflowId: string,
  postCommit: Context.Tag.Service<typeof WorkflowRuntimePostCommitWork>,
  source: PostCommitWorkSource,
): Effect.Effect<
  WorkflowRuntimeCommandOutcome<WorkflowRuntimeReviewDecisionResult>,
  never
> {
  if (!result.decided) {
    return Effect.succeed(ignored("STALE_TASK_RUN"));
  }

  return Effect.gen(function* () {
    yield* postCommit.deliver(
      postCommitWork({
        source,
        taskStatusEvents: [result.event],
        wakeUpJobs: [result.wakeUpJob],
        workflowId,
      }),
    );
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

function postCommitWork(
  work: Pick<PostCommitWork, "source" | "workflowId"> &
    Partial<
      Pick<PostCommitWork, "executionJobs" | "taskStatusEvents" | "wakeUpJobs">
    >,
): PostCommitWork {
  return {
    executionJobs: work.executionJobs ?? [],
    source: work.source,
    taskStatusEvents: work.taskStatusEvents ?? [],
    wakeUpJobs: work.wakeUpJobs ?? [],
    workflowId: work.workflowId,
  };
}
