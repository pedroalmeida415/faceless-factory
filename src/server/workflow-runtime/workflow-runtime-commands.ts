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
  WorkflowRuntimeEventPublisherForCommands,
  WorkflowRuntimeQueueForCommands,
  WorkflowRuntimeRejectTaskRunResult,
  WorkflowRuntimeRepositoryForCommands,
  WorkflowRuntimeReviewDecisionResult,
  WorkflowRuntimeSettleCompletionResult,
  WorkflowRuntimeSettleFailureResult,
} from "~/server/workflow-runtime/workflow-runtime-command-types";
import { WorkflowRuntimePostCommitWork } from "~/server/workflow-runtime/workflow-runtime-post-commit-work";
import type {
  RepositoryCommittedOutcome,
  StaleTaskRunTransition,
  WakeUpParentNotFound,
  WakeUpTaskRunChildrenRepositoryResult,
  WorkflowRuntimeRepositoryFailure,
} from "~/server/workflow-runtime/workflow-runtime-repository";

export type WorkflowRuntimeCommandError =
  | (WorkflowRunPlannerError & { readonly committed: false })
  | StaleTaskRunTransition
  | WakeUpParentNotFound
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
)<WorkflowRuntimeRepository, WorkflowRuntimeRepositoryForCommands>() {}

export class WorkflowRuntimeQueue extends Context.Tag("WorkflowRuntimeQueue")<
  WorkflowRuntimeQueue,
  WorkflowRuntimeQueueForCommands
>() {}

export class WorkflowRuntimeEventPublisher extends Context.Tag(
  "WorkflowRuntimeEventPublisher",
)<WorkflowRuntimeEventPublisher, WorkflowRuntimeEventPublisherForCommands>() {}

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
      WorkflowRuntimeCommandError
    >;
    readonly cancelTaskRun: (
      command: ReviewTaskRunDecisionCommand,
    ) => Effect.Effect<
      WorkflowRuntimeCommandOutcome<WorkflowRuntimeReviewDecisionResult>,
      WorkflowRuntimeCommandError
    >;
    readonly handleWakeUpCall: (
      command: HandleWakeUpCallCommand,
    ) => Effect.Effect<
      WorkflowRuntimeCommandOutcome<WakeUpTaskRunChildrenRepositoryResult>,
      WorkflowRuntimeCommandError
    >;
    readonly rejectTaskRun: (
      command: RejectTaskRunCommand,
    ) => Effect.Effect<
      WorkflowRuntimeCommandOutcome<WorkflowRuntimeRejectTaskRunResult>,
      WorkflowRuntimeCommandError
    >;
    readonly settleWorkerCompletion: (
      command: SettleWorkerCompletionCommand,
    ) => Effect.Effect<
      WorkflowRuntimeCommandOutcome<WorkflowRuntimeSettleCompletionResult>,
      WorkflowRuntimeCommandError
    >;
    readonly settleWorkerFailure: (
      command: SettleWorkerFailureCommand,
    ) => Effect.Effect<
      WorkflowRuntimeCommandOutcome<WorkflowRuntimeSettleFailureResult>,
      WorkflowRuntimeCommandError
    >;
    readonly startWorkflowRun: (
      input: StartWorkflowRunInput,
    ) => Effect.Effect<
      WorkflowRuntimeCommandOutcome<WorkflowRuntimeCommitPlanResult>,
      WorkflowRuntimeCommandError
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
          handleReviewDecision(repository.approveTaskRun(command), postCommit),
        cancelTaskRun: (command) =>
          Effect.flatMap(
            mapRepositoryErrors(
              repository.cancelTaskRun(command),
              "Failed to cancel Task Run.",
            ).pipe(
              Effect.catchTag("StaleTaskRunTransition", () =>
                Effect.succeed(null),
              ),
            ),
            (outcome) =>
              !outcome
                ? Effect.succeed(ignored("STALE_TASK_RUN"))
                : "blocked" in outcome.value
                  ? Effect.fail({
                      _tag: "TaskRunCancellationBlockedError",
                      committed: false,
                      message: outcome.value.message,
                      reason: outcome.value.reason,
                    } as const)
                  : handleCommittedReviewDecision(outcome, postCommit),
          ),
        handleWakeUpCall: (command) =>
          Effect.gen(function* () {
            const outcome = yield* mapRepositoryErrors(
              repository.wakeUpTaskRunChildren(command),
              "Failed to handle Wake-Up Call.",
            ).pipe(
              Effect.catchTag("WakeUpParentNotFound", () =>
                Effect.succeed(null),
              ),
            );
            if (!outcome) {
              return ignored("WAKE_UP_PARENT_NOT_FOUND");
            }
            if (isEmptyWakeUpOutcome(outcome) && !outcome.durableStateChanged) {
              return ignored("STALE_TASK_RUN");
            }
            yield* postCommit.deliver(outcome.postCommitWork);
            return committed(outcome.value);
          }),
        rejectTaskRun: (command) =>
          Effect.gen(function* () {
            const outcome = yield* mapRepositoryErrors(
              repository.rejectTaskRunAndCreateRegeneration({
                ...command,
                newTaskRunId: ids.createTaskRunId(),
              } satisfies RejectTaskRunRepositoryCommand),
              "Failed to reject Task Run.",
            ).pipe(
              Effect.catchTag("StaleTaskRunTransition", () =>
                Effect.succeed(null),
              ),
            );
            if (!outcome) {
              return ignored("STALE_TASK_RUN");
            }
            yield* postCommit.deliver(outcome.postCommitWork);
            return committed(outcome.value);
          }),
        settleWorkerCompletion: (command) =>
          Effect.gen(function* () {
            const outcome = yield* mapRepositoryErrors(
              repository.settleTaskRunCompletion(command),
              "Failed to settle completed Task Run.",
            ).pipe(
              Effect.catchTag("StaleTaskRunTransition", () =>
                Effect.succeed(null),
              ),
            );
            if (!outcome) {
              return ignored("STALE_TASK_RUN");
            }
            yield* postCommit.deliver(outcome.postCommitWork);
            return committed(outcome.value);
          }),
        settleWorkerFailure: (command) =>
          Effect.gen(function* () {
            const outcome = yield* mapRepositoryErrors(
              repository.settleTaskRunFailure(command),
              "Failed to settle failed Task Run.",
            ).pipe(
              Effect.catchTag("StaleTaskRunTransition", () =>
                Effect.succeed(null),
              ),
            );
            if (!outcome) {
              return ignored("STALE_TASK_RUN");
            }
            yield* postCommit.deliver(outcome.postCommitWork);
            return committed(outcome.value);
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

            const outcome = yield* mapRepositoryErrors(
              repository.commitWorkflowRunPlan(planning.value),
              "Failed to commit Workflow Run plan.",
            );
            yield* postCommit.deliver(outcome.postCommitWork);
            return committed(outcome.value);
          }),
      };
    }),
  );
}

export type WorkflowRuntimeCommandsService = Context.Tag.Service<
  typeof WorkflowRuntimeCommands
>;

function handleReviewDecision(
  decide: ReturnType<WorkflowRuntimeRepositoryForCommands["approveTaskRun"]>,
  postCommit: Context.Tag.Service<typeof WorkflowRuntimePostCommitWork>,
) {
  return Effect.gen(function* () {
    const outcome = yield* mapRepositoryErrors<
      RepositoryCommittedOutcome<WorkflowRuntimeReviewDecisionResult>
    >(decide, "Failed to decide Task Run review.").pipe(
      Effect.catchTag("StaleTaskRunTransition", () => Effect.succeed(null)),
    );
    if (!outcome) {
      return ignored<WorkflowRuntimeReviewDecisionResult>("STALE_TASK_RUN");
    }
    return yield* handleCommittedReviewDecision(outcome, postCommit);
  });
}

function handleCommittedReviewDecision(
  outcome: RepositoryCommittedOutcome<WorkflowRuntimeReviewDecisionResult>,
  postCommit: Context.Tag.Service<typeof WorkflowRuntimePostCommitWork>,
) {
  return Effect.gen(function* () {
    yield* postCommit.deliver(outcome.postCommitWork);
    return committed<WorkflowRuntimeReviewDecisionResult>(outcome.value);
  });
}

function mapRepositoryErrors<T>(
  run: Effect.Effect<T, WorkflowRuntimeRepositoryFailure>,
  message: string,
) {
  return run.pipe(
    Effect.mapError((error) => {
      if (
        error._tag === "StaleTaskRunTransition" ||
        error._tag === "WakeUpParentNotFound"
      ) {
        return error;
      }
      return {
        _tag: "WorkflowRuntimeCommitError",
        cause: error.cause,
        committed: false,
        message,
      } as const;
    }),
  );
}

function isEmptyWakeUpOutcome(
  outcome: RepositoryCommittedOutcome<WakeUpTaskRunChildrenRepositoryResult>,
) {
  return (
    outcome.value.parentFound &&
    outcome.value.executionJobs.length === 0 &&
    outcome.value.taskStatusEvents.length === 0
  );
}
