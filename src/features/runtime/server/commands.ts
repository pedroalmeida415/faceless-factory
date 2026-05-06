import { randomUUID } from "node:crypto";
import { Context, Effect, Layer } from "effect";
import {
  planWorkflowRun,
  type WorkflowRunPlannerError,
} from "~/features/runtime/planning/workflow-run-planner";
import {
  committed,
  ignored,
  type RuntimeCommandOutcome,
} from "~/features/runtime/server/command-outcome";
import type {
  EventPublisherServiceForCommands,
  HandleWakeUpCallCommand,
  RejectTaskRunCommand,
  RejectTaskRunRepositoryCommand,
  ReviewTaskRunDecisionCommand,
  RuntimeCommitPlanResult,
  RuntimeRejectTaskRunResult,
  RuntimeRepositoryForCommands,
  RuntimeReviewDecisionResult,
  RuntimeSettleCompletionResult,
  RuntimeSettleFailureResult,
  SettleWorkerCompletionCommand,
  SettleWorkerFailureCommand,
  StartWorkflowRunInput,
  TaskRunCancellationBlockedReason,
} from "~/features/runtime/server/command-types";
import { RuntimePostCommitWork } from "~/features/runtime/server/post-commit-work";
import type {
  RepositoryCommittedOutcome,
  RuntimeRepositoryFailure,
  StaleTaskRunTransition,
  WakeUpParentNotFound,
  WakeUpTaskRunChildrenRepositoryResult,
} from "~/features/runtime/server/repository";

export type RuntimeCommandError =
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
      readonly _tag: "RuntimeCommitError";
      readonly cause: unknown;
      readonly committed: false;
      readonly message: string;
    };

export class RuntimeRepository extends Context.Tag("RuntimeRepository")<
  RuntimeRepository,
  RuntimeRepositoryForCommands
>() {}

export class EventPublisherService extends Context.Tag("EventPublisherService")<
  EventPublisherService,
  EventPublisherServiceForCommands
>() {}

export class RuntimeIdGenerator extends Context.Tag("RuntimeIdGenerator")<
  RuntimeIdGenerator,
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

export class RuntimeCommands extends Context.Tag("RuntimeCommands")<
  RuntimeCommands,
  {
    readonly approveTaskRun: (
      command: ReviewTaskRunDecisionCommand,
    ) => Effect.Effect<
      RuntimeCommandOutcome<RuntimeReviewDecisionResult>,
      RuntimeCommandError
    >;
    readonly cancelTaskRun: (
      command: ReviewTaskRunDecisionCommand,
    ) => Effect.Effect<
      RuntimeCommandOutcome<RuntimeReviewDecisionResult>,
      RuntimeCommandError
    >;
    readonly handleWakeUpCall: (
      command: HandleWakeUpCallCommand,
    ) => Effect.Effect<
      RuntimeCommandOutcome<WakeUpTaskRunChildrenRepositoryResult>,
      RuntimeCommandError
    >;
    readonly rejectTaskRun: (
      command: RejectTaskRunCommand,
    ) => Effect.Effect<
      RuntimeCommandOutcome<RuntimeRejectTaskRunResult>,
      RuntimeCommandError
    >;
    readonly settleWorkerCompletion: (
      command: SettleWorkerCompletionCommand,
    ) => Effect.Effect<
      RuntimeCommandOutcome<RuntimeSettleCompletionResult>,
      RuntimeCommandError
    >;
    readonly settleWorkerFailure: (
      command: SettleWorkerFailureCommand,
    ) => Effect.Effect<
      RuntimeCommandOutcome<RuntimeSettleFailureResult>,
      RuntimeCommandError
    >;
    readonly startWorkflowRun: (
      input: StartWorkflowRunInput,
    ) => Effect.Effect<
      RuntimeCommandOutcome<RuntimeCommitPlanResult>,
      RuntimeCommandError
    >;
  }
>() {
  static readonly Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const repository = yield* RuntimeRepository;
      const ids = yield* RuntimeIdGenerator;
      const postCommit = yield* RuntimePostCommitWork;

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

export type RuntimeCommandsService = Context.Tag.Service<
  typeof RuntimeCommands
>;

function handleReviewDecision(
  decide: ReturnType<RuntimeRepositoryForCommands["approveTaskRun"]>,
  postCommit: Context.Tag.Service<typeof RuntimePostCommitWork>,
) {
  return Effect.gen(function* () {
    const outcome = yield* mapRepositoryErrors<
      RepositoryCommittedOutcome<RuntimeReviewDecisionResult>
    >(decide, "Failed to decide Task Run review.").pipe(
      Effect.catchTag("StaleTaskRunTransition", () => Effect.succeed(null)),
    );
    if (!outcome) {
      return ignored<RuntimeReviewDecisionResult>("STALE_TASK_RUN");
    }
    return yield* handleCommittedReviewDecision(outcome, postCommit);
  });
}

function handleCommittedReviewDecision(
  outcome: RepositoryCommittedOutcome<RuntimeReviewDecisionResult>,
  postCommit: Context.Tag.Service<typeof RuntimePostCommitWork>,
) {
  return Effect.gen(function* () {
    yield* postCommit.deliver(outcome.postCommitWork);
    return committed<RuntimeReviewDecisionResult>(outcome.value);
  });
}

function mapRepositoryErrors<T>(
  run: Effect.Effect<T, RuntimeRepositoryFailure>,
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
        _tag: "RuntimeCommitError",
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
