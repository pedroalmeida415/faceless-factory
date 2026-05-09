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
  RejectTaskCommand,
  RejectTaskRepositoryCommand,
  ReviewTaskDecisionCommand,
  RuntimeCommitPlanResult,
  RuntimeRejectTaskResult,
  RuntimeRepositoryForCommands,
  RuntimeReviewDecisionResult,
  RuntimeSettleCompletionResult,
  RuntimeSettleFailureResult,
  SettleWorkerCompletionCommand,
  SettleWorkerFailureCommand,
  StartWorkflowRunInput,
  TaskCancellationBlockedReason,
} from "~/features/runtime/server/command-types";
import { RuntimePostCommitWork } from "~/features/runtime/server/post-commit-work";
import type {
  RepositoryCommittedOutcome,
  RuntimeRepositoryFailure,
  StaleTaskTransition,
  WakeUpParentNotFound,
  WakeUpTaskChildrenRepositoryResult,
} from "~/features/runtime/server/repository";

export type RuntimeCommandError =
  | (WorkflowRunPlannerError & { readonly committed: false })
  | StaleTaskTransition
  | WakeUpParentNotFound
  | {
      readonly _tag: "TaskCancellationBlockedError";
      readonly committed: false;
      readonly message: string;
      readonly reason: TaskCancellationBlockedReason;
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
>() {
  static readonly Test = Layer.succeed(this, {
    publishTaskStatusEvent: () => Effect.void,
  });
}

export class RuntimeIdGenerator extends Context.Tag("RuntimeIdGenerator")<
  RuntimeIdGenerator,
  {
    readonly createNodeRunId: () => string;
    readonly createTaskId: () => string;
  }
>() {
  static readonly Test = Layer.sync(this, () => {
    let nodeRunId = 0;
    let taskId = 0;
    return {
      createNodeRunId: () => `test-node-run-${++nodeRunId}`,
      createTaskId: () => `test-task-${++taskId}`,
    };
  });

  static readonly Live = Layer.succeed(this, {
    createNodeRunId: randomUUID,
    createTaskId: randomUUID,
  });
}

export class RuntimeCommands extends Context.Tag("RuntimeCommands")<
  RuntimeCommands,
  {
    readonly approveTask: (
      command: ReviewTaskDecisionCommand,
    ) => Effect.Effect<
      RuntimeCommandOutcome<RuntimeReviewDecisionResult>,
      RuntimeCommandError
    >;
    readonly cancelTask: (
      command: ReviewTaskDecisionCommand,
    ) => Effect.Effect<
      RuntimeCommandOutcome<RuntimeReviewDecisionResult>,
      RuntimeCommandError
    >;
    readonly handleWakeUpCall: (
      command: HandleWakeUpCallCommand,
    ) => Effect.Effect<
      RuntimeCommandOutcome<WakeUpTaskChildrenRepositoryResult>,
      RuntimeCommandError
    >;
    readonly rejectTask: (
      command: RejectTaskCommand,
    ) => Effect.Effect<
      RuntimeCommandOutcome<RuntimeRejectTaskResult>,
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
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const repository = yield* RuntimeRepository;
      const ids = yield* RuntimeIdGenerator;
      const postCommit = yield* RuntimePostCommitWork;

      return {
        approveTask: (command) =>
          handleReviewDecision(repository.approveTask(command), postCommit),
        cancelTask: (command) =>
          Effect.flatMap(
            mapRepositoryErrors(
              repository.cancelTask(command),
              "Failed to cancel Task.",
            ).pipe(
              Effect.catchTag("StaleTaskTransition", () =>
                Effect.succeed(null),
              ),
            ),
            (outcome) =>
              !outcome
                ? Effect.succeed(ignored("STALE_TASK_RUN"))
                : "blocked" in outcome.value
                  ? Effect.fail({
                      _tag: "TaskCancellationBlockedError",
                      committed: false,
                      message: outcome.value.message,
                      reason: outcome.value.reason,
                    } as const)
                  : handleCommittedReviewDecision(outcome, postCommit),
          ),
        handleWakeUpCall: (command) =>
          Effect.gen(function* () {
            const outcome = yield* mapRepositoryErrors(
              repository.wakeUpTaskChildren(command),
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
        rejectTask: (command) =>
          Effect.gen(function* () {
            const outcome = yield* mapRepositoryErrors(
              repository.rejectTaskAndCreateRegeneration({
                ...command,
                newTaskId: ids.createTaskId(),
              } satisfies RejectTaskRepositoryCommand),
              "Failed to reject Task.",
            ).pipe(
              Effect.catchTag("StaleTaskTransition", () =>
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
              repository.settleTaskCompletion(command),
              "Failed to settle completed Task.",
            ).pipe(
              Effect.catchTag("StaleTaskTransition", () =>
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
              repository.settleTaskFailure(command),
              "Failed to settle failed Task.",
            ).pipe(
              Effect.catchTag("StaleTaskTransition", () =>
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
              createNodeRunId: ids.createNodeRunId,
              createTaskId: ids.createTaskId,
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

  static readonly Test = RuntimeCommands.layer;

  static readonly Live = RuntimeCommands.layer;
}

export type RuntimeCommandsService = Context.Tag.Service<
  typeof RuntimeCommands
>;

function handleReviewDecision(
  decide: ReturnType<RuntimeRepositoryForCommands["approveTask"]>,
  postCommit: Context.Tag.Service<typeof RuntimePostCommitWork>,
) {
  return Effect.gen(function* () {
    const outcome = yield* mapRepositoryErrors<
      RepositoryCommittedOutcome<RuntimeReviewDecisionResult>
    >(decide, "Failed to decide Task review.").pipe(
      Effect.catchTag("StaleTaskTransition", () => Effect.succeed(null)),
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
        error._tag === "StaleTaskTransition" ||
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
  outcome: RepositoryCommittedOutcome<WakeUpTaskChildrenRepositoryResult>,
) {
  return (
    outcome.value.parentFound &&
    outcome.value.executionJobs.length === 0 &&
    outcome.value.taskStatusEvents.length === 0
  );
}
