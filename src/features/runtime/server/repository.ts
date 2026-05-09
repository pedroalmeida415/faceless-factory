import { SqlClient } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { inArray, sql } from "drizzle-orm";
import { type Context, Effect, Layer } from "effect";
import { projectGeneratedAssetToTaskOutput } from "~/features/runtime/assets/generated-asset-projection";
import type {
  TaskFailureReason,
  TaskSettlementFailureSource,
} from "~/features/runtime/domain/task-state";
import {
  buildTaskStatusEvent,
  type TaskStatusEvent,
} from "~/features/runtime/events/task-status-events";
import {
  buildTaskInputSnapshot,
  type ExecutableTaskInputSnapshot,
  isTaskInputSnapshot,
  type TaskInputSnapshot,
} from "~/features/runtime/execution/task-input-snapshot";
import {
  recordDirectTaskFailure,
  type TaskGatekeeperState,
  type TaskGatekeeperTask,
  wakeUpTaskChildren,
} from "~/features/runtime/gatekeeper/task-gatekeeper";
import type { WorkflowRunPlan } from "~/features/runtime/planning/workflow-run-planner";
import { RuntimeRepository as RuntimeRepositoryTag } from "~/features/runtime/server/commands";
import type {
  PostCommitWork,
  PostCommitWorkSource,
} from "~/features/runtime/server/post-commit-work";
import { buildTaskCreditLedgerSourceKey } from "~/features/runtime/server/task-credit-ledger";
import type { WorkflowAsset } from "~/features/workflow/types";
import type { tasks } from "~/server/database/schema";
import * as schema from "~/server/database/schema";
import { DatabaseService } from "~/server/services/database";
import {
  buildRuntimeExecutionJobPayload,
  buildRuntimeWakeUpJobPayload,
  type RuntimeExecutionJobPayload,
  type RuntimeGeneratedPrimaryAssetPayload,
  type RuntimeWakeUpJobPayload,
} from "~/server/services/queue";
import { promoteStagedGeneratedArtifact } from "~/server/services/storage";

type ClaimQueuedTaskCommand = {
  readonly taskId: string;
  readonly ownerUserId: string;
};

type ClaimQueuedTaskResult =
  | {
      readonly claimed: true;
      readonly event: TaskStatusEvent;
      readonly inputSnapshot: ExecutableTaskInputSnapshot;
    }
  | { readonly claimed: false };

type SettleTaskCompletionCommand = {
  readonly providerCostCredits: number;
  readonly generatedAsset: RuntimeGeneratedPrimaryAssetPayload;
  readonly ownerUserId: string;
  readonly reviewRequired: boolean;
  readonly taskId: string;
  readonly workflowId: string;
};

type SettleTaskCompletionResult =
  | {
      readonly settled: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: RuntimeWakeUpJobPayload | null;
    }
  | { readonly settled: false };

type SettleTaskFailureCommand = {
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

type SettleTaskFailureResult =
  | {
      readonly settled: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: RuntimeWakeUpJobPayload;
    }
  | { readonly settled: false };

type DecideTaskReviewCommand = {
  readonly ownerUserId: string;
  readonly taskId: string;
};

type RejectTaskAndCreateRegenerationCommand = DecideTaskReviewCommand & {
  readonly newTaskId: string;
};

type ReviewDecisionResult =
  | {
      readonly decided: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: RuntimeWakeUpJobPayload;
    }
  | { readonly decided: false };

type RejectTaskResult =
  | {
      readonly executionJob: RuntimeExecutionJobPayload | null;
      readonly rejected: true;
      readonly taskStatusEvents: readonly TaskStatusEvent[];
    }
  | { readonly rejected: false };

type CancelTaskBlockedReason =
  | "PENDING_REVIEW_REQUIRES_REVIEW_DECISION"
  | "RUNNING_TASK_RUN_CANCELLATION_BLOCKED";

type CancelTaskResult =
  | {
      readonly decided: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: RuntimeWakeUpJobPayload;
    }
  | { readonly decided: false }
  | {
      readonly blocked: true;
      readonly decided: false;
      readonly message: string;
      readonly reason: CancelTaskBlockedReason;
    };

type CreditLedgerForUser = {
  readonly creditBalance: number;
  readonly ledgerEntries: readonly {
    readonly amount: number;
    readonly balanceAfter: number;
    readonly kind: string;
    readonly sourceKey: string;
  }[];
};

type TaskDependencyForChild = {
  readonly childTaskId: string;
  readonly requiredParentBranchIndex: number;
  readonly requiredParentNodeRunId: string;
  readonly requiredParentNodeId: string;
  readonly resolvedParentTaskId: string | null;
  readonly sourceHandle: string | null;
  readonly targetHandle: string | null;
  readonly targetNodeId: string;
};

export type WakeUpTaskChildrenRepositoryCommand = {
  readonly ownerUserId: string;
  readonly settledParentTaskId: string;
};

export type WakeUpTaskChildrenRepositoryResult = {
  readonly executionJobs: readonly RuntimeExecutionJobPayload[];
  readonly parentFound: boolean;
  readonly taskStatusEvents: readonly TaskStatusEvent[];
};

type CommitWorkflowRunPlanResult = {
  readonly executionJobs: readonly RuntimeExecutionJobPayload[];
  readonly taskStatusEvents: readonly TaskStatusEvent[];
  readonly wakeUpJobs: readonly RuntimeWakeUpJobPayload[];
};

export type RepositoryCommittedOutcome<T> = {
  readonly durableStateChanged?: boolean;
  readonly postCommitWork: PostCommitWork;
  readonly value: T;
};

export type StaleTaskTransition = {
  readonly _tag: "StaleTaskTransition";
  readonly operation: string;
  readonly taskId: string;
};

export type WakeUpParentNotFound = {
  readonly _tag: "WakeUpParentNotFound";
  readonly ownerUserId: string;
  readonly settledParentTaskId: string;
};

export type RuntimeRepositoryFailure =
  | StaleTaskTransition
  | WakeUpParentNotFound
  | {
      readonly _tag: "RuntimeRepositoryFailure";
      readonly cause: unknown;
      readonly operation: string;
    };

type CommittedPlanTask = Omit<
  WorkflowRunPlan["tasksToCreate"][number],
  "failureReason" | "status"
> & {
  readonly failureReason?: "EXECUTION_FAILED" | "INSUFFICIENT_CREDITS";
  readonly status: "FAILED" | "QUEUED" | "WAITING_UPSTREAM";
};

type RuntimeTaskRow = {
  readonly inputSnapshot: TaskInputSnapshot | null;
  readonly branchIndex: number;
  readonly nodeRunId: string;
  readonly ownerUserId: string;
  readonly runtimeStatus: NonNullable<
    (typeof tasks.$inferSelect)["runtimeStatus"]
  >;
  readonly taskId: string;
  readonly workflowId: string;
};

type ResolvedParentTaskSnapshot =
  TaskInputSnapshot["resolvedParentTasks"][number];

type NodeRunIdentity = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly workflowId: string;
};

type RuntimeRepositorySqlServices = SqlClient.SqlClient | PgDrizzle.PgDrizzle;

type RuntimeRepository<R> = {
  readonly approveTask: (
    command: DecideTaskReviewCommand & { workflowId: string },
  ) => Effect.Effect<
    RepositoryCommittedOutcome<
      Extract<ReviewDecisionResult, { decided: true }>
    >,
    RuntimeRepositoryFailure,
    R
  >;
  readonly cancelTask: (
    command: DecideTaskReviewCommand & { workflowId: string },
  ) => Effect.Effect<
    RepositoryCommittedOutcome<CancelTaskResult>,
    RuntimeRepositoryFailure,
    R
  >;
  readonly claimQueuedTask: (
    command: ClaimQueuedTaskCommand,
  ) => Effect.Effect<ClaimQueuedTaskResult, RuntimeRepositoryFailure, R>;
  readonly commitWorkflowRunPlan: (
    plan: WorkflowRunPlan,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<CommitWorkflowRunPlanResult>,
    RuntimeRepositoryFailure,
    R
  >;
  readonly getCreditLedgerForUser: (command: {
    readonly ownerUserId: string;
  }) => Effect.Effect<CreditLedgerForUser, RuntimeRepositoryFailure, R>;
  readonly getRuntimeTasksForNodeRun: (command: {
    readonly nodeRunId: string;
    readonly ownerUserId: string;
  }) => Effect.Effect<readonly RuntimeTaskRow[], RuntimeRepositoryFailure, R>;
  readonly getTaskDependenciesForChild: (command: {
    readonly childTaskId: string;
  }) => Effect.Effect<
    readonly TaskDependencyForChild[],
    RuntimeRepositoryFailure,
    R
  >;
  readonly rejectTaskAndCreateRegeneration: (
    command: RejectTaskAndCreateRegenerationCommand & { workflowId: string },
  ) => Effect.Effect<
    RepositoryCommittedOutcome<Extract<RejectTaskResult, { rejected: true }>>,
    RuntimeRepositoryFailure,
    R
  >;
  readonly settleTaskCompletion: (
    command: SettleTaskCompletionCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<SettleTaskCompletionResult>,
    RuntimeRepositoryFailure,
    R
  >;
  readonly settleTaskFailure: (
    command: SettleTaskFailureCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<SettleTaskFailureResult>,
    RuntimeRepositoryFailure,
    R
  >;
  readonly wakeUpTaskChildren: (
    command: WakeUpTaskChildrenRepositoryCommand & { workflowId: string },
  ) => Effect.Effect<
    RepositoryCommittedOutcome<WakeUpTaskChildrenRepositoryResult>,
    RuntimeRepositoryFailure,
    R
  >;
};

export function createRuntimeRepository(): RuntimeRepository<DatabaseService> {
  return buildRuntimeRepository((effect) =>
    Effect.flatMap(DatabaseService, (database) => database.run(effect)),
  );
}

export function createRuntimeRepositoryFromDatabase(
  database: Context.Tag.Service<typeof DatabaseService>,
): RuntimeRepository<never> {
  return buildRuntimeRepository((effect) => database.run(effect));
}

export const RuntimeRepositoryLive = Layer.effect(
  RuntimeRepositoryTag,
  Effect.map(DatabaseService, createRuntimeRepositoryFromDatabase),
);

export const RuntimeRepositoryTest = Layer.effect(
  RuntimeRepositoryTag,
  Effect.map(DatabaseService, createRuntimeRepositoryFromDatabase),
);

function buildRuntimeRepository<R>(
  provideSql: <A>(
    effect: Effect.Effect<
      A,
      RuntimeRepositoryFailure,
      RuntimeRepositorySqlServices
    >,
  ) => Effect.Effect<A, RuntimeRepositoryFailure, R>,
): RuntimeRepository<R> {
  return {
    commitWorkflowRunPlan: (plan: WorkflowRunPlan) =>
      provideSql(commitWorkflowRunPlanEffect(plan)),
    claimQueuedTask: (command: ClaimQueuedTaskCommand) =>
      provideSql(claimQueuedTaskEffect(command)),
    settleTaskCompletion: (command: SettleTaskCompletionCommand) =>
      provideSql(settleTaskCompletionEffect(command)).pipe(
        Effect.flatMap((outcome) =>
          outcome.value.settled
            ? Effect.succeed({
                postCommitWork: outcome.postCommitWork,
                value: outcome.value,
              })
            : staleTaskTransition(command, "settleTaskCompletion"),
        ),
      ),
    settleTaskFailure: (command: SettleTaskFailureCommand) =>
      provideSql(settleTaskFailureEffect(command)).pipe(
        Effect.flatMap((outcome) =>
          outcome.value.settled
            ? Effect.succeed({
                postCommitWork: outcome.postCommitWork,
                value: outcome.value,
              })
            : staleTaskTransition(command, "settleTaskFailure"),
        ),
      ),
    approveTask: (command: DecideTaskReviewCommand & { workflowId: string }) =>
      provideSql(approveTaskEffect(command)).pipe(
        Effect.flatMap((outcome) =>
          outcome.value.decided
            ? Effect.succeed({
                postCommitWork: outcome.postCommitWork,
                value: outcome.value,
              })
            : staleTaskTransition(command, "approveTask"),
        ),
      ),
    cancelTask: (command: DecideTaskReviewCommand & { workflowId: string }) =>
      provideSql(cancelTaskEffect(command)).pipe(
        Effect.flatMap((value) =>
          "blocked" in value.value || value.value.decided
            ? Effect.succeed(value)
            : staleTaskTransition(command, "cancelTask"),
        ),
      ),
    rejectTaskAndCreateRegeneration: (
      command: RejectTaskAndCreateRegenerationCommand & {
        workflowId: string;
      },
    ) =>
      provideSql(rejectTaskAndCreateRegenerationEffect(command)).pipe(
        Effect.flatMap((outcome) =>
          outcome.value.rejected
            ? Effect.succeed({
                postCommitWork: outcome.postCommitWork,
                value: outcome.value,
              })
            : staleTaskTransition(command, "rejectTaskAndCreateRegeneration"),
        ),
      ),
    wakeUpTaskChildren: (
      command: WakeUpTaskChildrenRepositoryCommand & { workflowId: string },
    ) =>
      provideSql(wakeUpTaskChildrenEffect(command)).pipe(
        Effect.flatMap((value) =>
          value.value.parentFound
            ? Effect.succeed(value)
            : Effect.fail({
                _tag: "WakeUpParentNotFound",
                ownerUserId: command.ownerUserId,
                settledParentTaskId: command.settledParentTaskId,
              } satisfies WakeUpParentNotFound),
        ),
      ),
    getRuntimeTasksForNodeRun: (command: {
      readonly nodeRunId: string;
      readonly ownerUserId: string;
    }) => provideSql(getRuntimeTasksForNodeRunEffect(command)),
    getTaskDependenciesForChild: (command: { readonly childTaskId: string }) =>
      provideSql(getTaskDependenciesForChildEffect(command)),
    getCreditLedgerForUser: (command: { readonly ownerUserId: string }) =>
      provideSql(getCreditLedgerForUserEffect(command)),
  };
}

function claimQueuedTaskEffect(command: ClaimQueuedTaskCommand) {
  return repositoryTransaction(
    "claimQueuedTask",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const [row] = yield* db
        .update(schema.tasks)
        .set({
          runtimeStatus: "RUNNING",
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(sql`${schema.tasks.id} = ${command.taskId}
          and ${schema.tasks.ownerUserId} = ${command.ownerUserId}
          and ${schema.tasks.runtimeStatus} = 'QUEUED'`)
        .returning({
          inputSnapshot: schema.tasks.inputSnapshot,
          branchIndex: schema.tasks.branchIndex,
          nodeRunId: schema.tasks.nodeRunId,
          taskId: schema.tasks.id,
        });

      if (!row) {
        return { claimed: false as const };
      }

      return {
        claimed: true as const,
        event: buildTaskStatusEvent({
          branchIndex: requireNumber(row.branchIndex),
          nodeRunId: row.nodeRunId,
          status: "RUNNING",
          taskId: row.taskId,
        }),
        inputSnapshot: requireExecutableTaskInputSnapshot(row.inputSnapshot),
      };
    }),
  );
}

function commitWorkflowRunPlanEffect(plan: WorkflowRunPlan) {
  return repositoryTransaction(
    "commitWorkflowRunPlan",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const nodeRunById = new Map<string, NodeRunIdentity>();

      for (const nodeRun of plan.nodeRunsToCreate) {
        nodeRunById.set(nodeRun.id, {
          id: nodeRun.id,
          ownerUserId: nodeRun.ownerId,
          workflowId: nodeRun.workflowId,
        });
        yield* db.insert(schema.nodeRuns).values({
          executionId: nodeRun.id,
          id: nodeRun.id,
          nodeId: nodeRun.nodeId,
          outputCount: countPlannedTasksForNodeRun(plan, nodeRun.id),
          ownerUserId: nodeRun.ownerId,
          status: "pending",
          targetReason: "node_run",
          workflowId: nodeRun.workflowId,
        });
      }

      yield* loadMissingNodeRunIdentitiesEffect(plan, nodeRunById);

      const committedTasks: CommittedPlanTask[] = [];
      for (const task of plan.tasksToCreate) {
        const nodeRun = requireNodeRunIdentity(nodeRunById, task.nodeRunId);
        const creditCost = task.creditCost;
        const debit =
          task.status === "QUEUED"
            ? yield* debitTaskCreditsEffect({
                amount: creditCost,
                ownerUserId: nodeRun.ownerUserId,
                taskId: task.id,
                workflowId: nodeRun.workflowId,
              })
            : {
                debited: false as const,
                reason: "INSUFFICIENT_CREDITS" as const,
              };
        const hasDebitedCredits = debit.debited;
        const committedTask: CommittedPlanTask =
          task.status !== "QUEUED" || hasDebitedCredits
            ? task
            : {
                ...task,
                failureReason: "INSUFFICIENT_CREDITS",
                status: "FAILED",
              };
        committedTasks.push(committedTask);

        const inputSnapshot =
          committedTask.status === "QUEUED" && hasDebitedCredits
            ? buildRepositoryInputSnapshot({
                branchIndex: task.branchIndex,
                nodeRunId: task.nodeRunId,
                nodeId: task.nodeId,
                resolvedParents: [],
                targetNodeConfig: task.targetNodeConfig,
                taskId: task.id,
                workflowDefinition: plan.workflowDefinition,
              })
            : committedTask.status === "WAITING_UPSTREAM"
              ? (task.inputSnapshot ??
                buildRepositoryInputSnapshot({
                  branchIndex: task.branchIndex,
                  nodeRunId: task.nodeRunId,
                  nodeId: task.nodeId,
                  resolvedParents: [],
                  targetNodeConfig: task.targetNodeConfig,
                  taskId: task.id,
                  workflowDefinition: plan.workflowDefinition,
                }))
              : null;

        yield* db.insert(schema.tasks).values({
          creditCost,
          executionId: task.nodeRunId,
          failedAt: committedTask.status === "FAILED" ? new Date() : null,
          failureReason: committedTask.failureReason,
          id: task.id,
          inputSnapshot,
          branchIndex: task.branchIndex,
          jobId: task.id,
          nodeRunId: task.nodeRunId,
          nodeId: task.nodeId,
          outputIndex: task.branchIndex,
          ownerUserId: nodeRun.ownerUserId,
          queuedAt: hasDebitedCredits ? new Date() : null,
          runtimeStatus: committedTask.status,
          status: "queued",
          targetReason: "node_run",
          version: 0,
          workflowId: nodeRun.workflowId,
        });
      }

      for (const dependency of plan.taskDependenciesToCreate) {
        yield* db.insert(schema.taskDependencies).values({
          childTaskId: dependency.childTaskId,
          id: buildTaskDependencyId(dependency),
          requiredParentBranchIndex: dependency.parentBranchIndex,
          requiredParentNodeRunId: dependency.parentNodeRunId,
          requiredParentNodeId: dependency.parentNodeId,
          sourceHandle: dependency.sourceHandle ?? null,
          targetHandle: dependency.targetHandle ?? null,
          targetNodeId: dependency.targetNodeId,
        });
      }

      for (const task of committedTasks) {
        if (task.status !== "QUEUED") {
          continue;
        }
        yield* resolveApprovedDependenciesForChildEffect(task.id);
        const resolvedParents = yield* loadResolvedParentSnapshotsEffect(
          task.id,
        );
        if (!resolvedParents.length) {
          continue;
        }
        yield* db
          .update(schema.tasks)
          .set({
            inputSnapshot: buildRepositoryInputSnapshot({
              documentRevision: task.inputSnapshot?.documentRevision,
              branchIndex: task.branchIndex,
              nodeRunId: task.nodeRunId,
              nodeId: task.nodeId,
              resolvedParents,
              targetNodeConfig: task.targetNodeConfig,
              taskId: task.id,
              workflowDefinition: plan.workflowDefinition,
            }),
            updatedAt: new Date(),
          })
          .where(sql`${schema.tasks.id} = ${task.id}`);
      }

      const value = buildCommittedPlanResult(committedTasks, nodeRunById);
      return committedOutcome(value, {
        executionJobs: value.executionJobs,
        source: "start-workflow-run",
        taskStatusEvents: value.taskStatusEvents,
        wakeUpJobs: value.wakeUpJobs,
        workflowId: workflowIdFromNodeRuns(nodeRunById),
      });
    }),
  );
}

function loadMissingNodeRunIdentitiesEffect(
  plan: WorkflowRunPlan,
  nodeRunById: Map<string, NodeRunIdentity>,
) {
  const missingNodeRunIds = Array.from(
    new Set([
      ...plan.nodeRunsToReuse.map((nodeRun) => nodeRun.id),
      ...plan.tasksToCreate.map((task) => task.nodeRunId),
      ...plan.taskDependenciesToCreate.flatMap((dependency) => [
        dependency.childNodeRunId,
        dependency.parentNodeRunId,
      ]),
    ]),
  ).filter((nodeRunId) => !nodeRunById.has(nodeRunId));

  if (!missingNodeRunIds.length) {
    return Effect.void;
  }

  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const rows = yield* db
      .select({
        id: schema.nodeRuns.id,
        ownerUserId: schema.nodeRuns.ownerUserId,
        workflowId: schema.nodeRuns.workflowId,
      })
      .from(schema.nodeRuns)
      .where(inArray(schema.nodeRuns.id, missingNodeRunIds));

    for (const row of rows) {
      nodeRunById.set(row.id, row);
    }
  });
}

function settleTaskCompletionEffect(command: SettleTaskCompletionCommand) {
  return repositoryTransaction(
    "settleTaskCompletion",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const output = projectGeneratedAssetToTaskOutput([
        command.generatedAsset,
      ]);
      if (output.kind === "INVALID_PRIMARY_GENERATED_ASSET_COUNT") {
        return yield* Effect.fail(new TypeError(output.message));
      }

      const finalStatus = command.reviewRequired
        ? "PENDING_REVIEW"
        : "APPROVED";
      const [row] = yield* db
        .update(schema.tasks)
        .set({
          assetIds: [command.generatedAsset.assetId],
          finishedAt: new Date(),
          runtimeStatus: finalStatus,
          updatedAt: new Date(),
        })
        .where(sql`${schema.tasks.id} = ${command.taskId}
        and ${schema.tasks.ownerUserId} = ${command.ownerUserId}
        and ${schema.tasks.runtimeStatus} = 'RUNNING'`)
        .returning({
          creditCost: schema.tasks.creditCost,
          branchIndex: schema.tasks.branchIndex,
          nodeRunId: schema.tasks.nodeRunId,
          ownerUserId: schema.tasks.ownerUserId,
          runtimeStatus: schema.tasks.runtimeStatus,
          taskId: schema.tasks.id,
          workflowId: schema.tasks.workflowId,
        });

      if (!row) {
        return committedOutcome(
          { settled: false as const },
          emptyPostCommitWork("settle-worker-completion", command.workflowId),
        );
      }

      if (command.generatedAsset.stagedStorageKey) {
        const { stagedStorageKey } = command.generatedAsset;
        yield* Effect.promise(() =>
          promoteStagedGeneratedArtifact({
            promotedStoragePath: requireString(
              command.generatedAsset.storageKey,
            ),
            stagedStoragePath: stagedStorageKey,
          }),
        );
      }

      yield* insertGeneratedAssetEffect({
        asset: command.generatedAsset,
        ownerUserId: row.ownerUserId,
        taskId: row.taskId,
        workflowId: row.workflowId,
      });
      yield* adjustTaskCostCreditsEffect({
        amount: taskCostAdjustmentCredits(
          row.creditCost,
          command.providerCostCredits,
        ),
        ownerUserId: row.ownerUserId,
        taskId: row.taskId,
        workflowId: row.workflowId,
      });

      const wakeUpJob =
        finalStatus === "APPROVED"
          ? buildRuntimeWakeUpJobPayload({
              ownerUserId: row.ownerUserId,
              parentTaskId: row.taskId,
              workflowId: row.workflowId,
            })
          : null;
      const value = {
        settled: true as const,
        event: buildTaskStatusEvent({
          branchIndex: requireNumber(row.branchIndex),
          nodeRunId: row.nodeRunId,
          output,
          status: finalStatus,
          taskId: row.taskId,
        }),
        wakeUpJob,
      };
      return committedOutcome(value, {
        executionJobs: [],
        source: "settle-worker-completion",
        taskStatusEvents: [value.event],
        wakeUpJobs: wakeUpJob ? [wakeUpJob] : [],
        workflowId: command.workflowId,
      });
    }),
  );
}

function settleTaskFailureEffect(command: SettleTaskFailureCommand) {
  return repositoryTransaction(
    "settleTaskFailure",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const failureMessage =
        "message" in command.failureReason
          ? command.failureReason.message
          : null;
      const failureReasonType = command.failureReason.type;
      const [row] = yield* db
        .update(schema.tasks)
        .set({
          error: failureMessage,
          failedAt: new Date(),
          failureReason: failureReasonType,
          finishedAt: new Date(),
          runtimeStatus: "FAILED",
          updatedAt: new Date(),
        })
        .where(sql`${schema.tasks.id} = ${command.taskId}
        and ${schema.tasks.ownerUserId} = ${command.ownerUserId}
        and ${schema.tasks.runtimeStatus} = 'RUNNING'`)
        .returning({
          creditCost: schema.tasks.creditCost,
          branchIndex: schema.tasks.branchIndex,
          nodeRunId: schema.tasks.nodeRunId,
          ownerUserId: schema.tasks.ownerUserId,
          taskId: schema.tasks.id,
          workflowId: schema.tasks.workflowId,
        });

      if (!row) {
        return committedOutcome(
          { settled: false as const },
          emptyPostCommitWork("settle-worker-failure", command.workflowId),
        );
      }

      if (command.failureSource.taskDebitRefundable) {
        yield* refundTaskCreditsEffect({
          amount: row.creditCost,
          ownerUserId: row.ownerUserId,
          taskId: row.taskId,
          workflowId: row.workflowId,
        });
      }
      yield* adjustTaskCostCreditsEffect({
        amount: taskCostAdjustmentCredits(
          row.creditCost,
          command.providerCostCredits ?? row.creditCost,
        ),
        ownerUserId: row.ownerUserId,
        taskId: row.taskId,
        workflowId: row.workflowId,
      });

      const wakeUpJob = buildRuntimeWakeUpJobPayload({
        ownerUserId: row.ownerUserId,
        parentTaskId: row.taskId,
        workflowId: row.workflowId,
      });
      const value = {
        settled: true as const,
        event: buildTaskStatusEvent({
          failureReason: failureReasonType,
          branchIndex: requireNumber(row.branchIndex),
          nodeRunId: row.nodeRunId,
          status: "FAILED",
          taskId: row.taskId,
        }),
        wakeUpJob,
      };
      return committedOutcome(value, {
        executionJobs: [],
        source: "settle-worker-failure",
        taskStatusEvents: [value.event],
        wakeUpJobs: [wakeUpJob],
        workflowId: command.workflowId,
      });
    }),
  );
}

function approveTaskEffect(
  command: DecideTaskReviewCommand & { readonly workflowId: string },
) {
  return repositoryTransaction(
    "approveTask",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const [row] = yield* db
        .update(schema.tasks)
        .set({
          finishedAt: new Date(),
          runtimeStatus: "APPROVED",
          updatedAt: new Date(),
        })
        .where(sql`${schema.tasks.id} = ${command.taskId}
          and ${schema.tasks.ownerUserId} = ${command.ownerUserId}
          and ${schema.tasks.runtimeStatus} = 'PENDING_REVIEW'`)
        .returning({
          branchIndex: schema.tasks.branchIndex,
          nodeRunId: schema.tasks.nodeRunId,
          ownerUserId: schema.tasks.ownerUserId,
          taskId: schema.tasks.id,
          workflowId: schema.tasks.workflowId,
        });
      if (!row) {
        return committedOutcome(
          { decided: false as const },
          emptyPostCommitWork("approve-task-run", command.workflowId),
        );
      }
      const wakeUpJob = buildRuntimeWakeUpJobPayload({
        ownerUserId: row.ownerUserId,
        parentTaskId: row.taskId,
        workflowId: row.workflowId,
      });
      const value = {
        decided: true as const,
        event: buildTaskStatusEvent({
          branchIndex: requireNumber(row.branchIndex),
          nodeRunId: row.nodeRunId,
          status: "APPROVED",
          taskId: row.taskId,
        }),
        wakeUpJob,
      };
      return committedOutcome(value, {
        executionJobs: [],
        source: "approve-task-run",
        taskStatusEvents: [value.event],
        wakeUpJobs: [wakeUpJob],
        workflowId: command.workflowId,
      });
    }),
  );
}

function cancelTaskEffect(
  command: DecideTaskReviewCommand & { readonly workflowId: string },
) {
  return repositoryTransaction(
    "cancelTask",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const [current] = yield* db
        .select({ runtimeStatus: schema.tasks.runtimeStatus })
        .from(schema.tasks)
        .where(sql`${schema.tasks.id} = ${command.taskId}
          and ${schema.tasks.ownerUserId} = ${command.ownerUserId}
`)
        .for("update")
        .limit(1);
      const [row] = yield* db
        .update(schema.tasks)
        .set({
          finishedAt: new Date(),
          runtimeStatus: "CANCELLED",
          updatedAt: new Date(),
        })
        .where(sql`${schema.tasks.id} = ${command.taskId}
          and ${schema.tasks.ownerUserId} = ${command.ownerUserId}
          and ${schema.tasks.runtimeStatus} in ('WAITING_UPSTREAM', 'QUEUED')`)
        .returning({
          creditCost: schema.tasks.creditCost,
          branchIndex: schema.tasks.branchIndex,
          nodeRunId: schema.tasks.nodeRunId,
          ownerUserId: schema.tasks.ownerUserId,
          taskId: schema.tasks.id,
          workflowId: schema.tasks.workflowId,
        });
      if (!row) {
        const status = yield* loadTaskRuntimeStatusEffect(command);
        return committedOutcome(
          blockedCancelResult(status),
          emptyPostCommitWork("cancel-task-run", command.workflowId),
        );
      }
      if (current?.runtimeStatus === "QUEUED") {
        yield* refundTaskCreditsEffect({
          amount: row.creditCost,
          ownerUserId: row.ownerUserId,
          taskId: row.taskId,
          workflowId: row.workflowId,
        });
      }
      const wakeUpJob = buildRuntimeWakeUpJobPayload({
        ownerUserId: row.ownerUserId,
        parentTaskId: row.taskId,
        workflowId: row.workflowId,
      });
      const value = {
        decided: true as const,
        event: buildTaskStatusEvent({
          branchIndex: requireNumber(row.branchIndex),
          nodeRunId: row.nodeRunId,
          status: "CANCELLED",
          taskId: row.taskId,
        }),
        wakeUpJob,
      };
      return committedOutcome(value, {
        executionJobs: [],
        source: "cancel-task-run",
        taskStatusEvents: [value.event],
        wakeUpJobs: [wakeUpJob],
        workflowId: command.workflowId,
      });
    }),
  );
}

function rejectTaskAndCreateRegenerationEffect(
  command: RejectTaskAndCreateRegenerationCommand & {
    readonly workflowId: string;
  },
) {
  return repositoryTransaction(
    "rejectTaskAndCreateRegeneration",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const [rejected] = yield* db
        .update(schema.tasks)
        .set({
          finishedAt: new Date(),
          runtimeStatus: "REJECTED",
          updatedAt: new Date(),
        })
        .where(sql`${schema.tasks.id} = ${command.taskId}
          and ${schema.tasks.ownerUserId} = ${command.ownerUserId}
          and ${schema.tasks.runtimeStatus} = 'PENDING_REVIEW'`)
        .returning({
          creditCost: schema.tasks.creditCost,
          executionId: schema.tasks.executionId,
          inputSnapshot: schema.tasks.inputSnapshot,
          branchIndex: schema.tasks.branchIndex,
          nodeRunId: schema.tasks.nodeRunId,
          nodeId: schema.tasks.nodeId,
          ownerUserId: schema.tasks.ownerUserId,
          targetReason: schema.tasks.targetReason,
          taskId: schema.tasks.id,
          workflowId: schema.tasks.workflowId,
        });
      if (!rejected) {
        return committedOutcome(
          { rejected: false as const },
          emptyPostCommitWork("reject-task-run", command.workflowId),
        );
      }
      const inputSnapshot = requireTaskInputSnapshot(rejected.inputSnapshot);
      const newSnapshot = buildRepositoryInputSnapshot({
        branchIndex: requireNumber(rejected.branchIndex),
        nodeRunId: rejected.nodeRunId,
        nodeId: rejected.nodeId,
        resolvedParents: inputSnapshot.resolvedParentTasks,
        targetNodeConfig: inputSnapshot.targetNodeConfig,
        taskId: command.newTaskId,
        workflowDefinition: inputSnapshot.workflowDefinition,
      });
      const debit = yield* debitTaskCreditsEffect({
        amount: rejected.creditCost,
        ownerUserId: rejected.ownerUserId,
        taskId: command.newTaskId,
        workflowId: rejected.workflowId,
      });
      const newStatus = debit.debited ? "QUEUED" : "FAILED";
      yield* db.insert(schema.tasks).values({
        creditCost: rejected.creditCost,
        executionId: rejected.executionId,
        failedAt: newStatus === "FAILED" ? new Date() : null,
        failureReason: newStatus === "FAILED" ? "INSUFFICIENT_CREDITS" : null,
        id: command.newTaskId,
        inputSnapshot: newStatus === "QUEUED" ? newSnapshot : null,
        branchIndex: requireNumber(rejected.branchIndex),
        jobId: command.newTaskId,
        nodeRunId: rejected.nodeRunId,
        nodeId: rejected.nodeId,
        outputIndex: requireNumber(rejected.branchIndex),
        ownerUserId: rejected.ownerUserId,
        queuedAt: newStatus === "QUEUED" ? new Date() : null,
        runtimeStatus: newStatus,
        status: "queued",
        targetReason: rejected.targetReason,
        version: 0,
        workflowId: rejected.workflowId,
      });
      const rejectedEvent = buildTaskStatusEvent({
        branchIndex: requireNumber(rejected.branchIndex),
        nodeRunId: rejected.nodeRunId,
        status: "REJECTED",
        taskId: rejected.taskId,
      });
      const newEvent = buildTaskStatusEvent({
        ...(newStatus === "FAILED"
          ? { failureReason: "INSUFFICIENT_CREDITS" as const }
          : {}),
        branchIndex: requireNumber(rejected.branchIndex),
        nodeRunId: rejected.nodeRunId,
        status: newStatus,
        taskId: command.newTaskId,
      });
      const executionJob =
        newStatus === "QUEUED"
          ? buildRuntimeExecutionJobPayload({
              branchIndex: requireNumber(rejected.branchIndex),
              nodeRunId: rejected.nodeRunId,
              ownerUserId: rejected.ownerUserId,
              taskId: command.newTaskId,
              workflowId: rejected.workflowId,
            })
          : null;
      const value = {
        executionJob,
        rejected: true as const,
        taskStatusEvents: [rejectedEvent, newEvent],
      };
      return committedOutcome(value, {
        executionJobs: executionJob ? [executionJob] : [],
        source: "reject-task-run",
        taskStatusEvents: value.taskStatusEvents,
        wakeUpJobs: [],
        workflowId: command.workflowId,
      });
    }),
  );
}

function wakeUpTaskChildrenEffect(
  command: WakeUpTaskChildrenRepositoryCommand & {
    readonly workflowId: string;
  },
) {
  return repositoryTransaction(
    "wakeUpTaskChildren",
    Effect.gen(function* () {
      const { durableStateChanged, ...value } =
        yield* runWakeUpTaskChildrenPersistenceEffect(command);
      return {
        durableStateChanged,
        ...committedOutcome(value, {
          executionJobs: value.executionJobs,
          source: "handle-wake-up-call",
          taskStatusEvents: value.taskStatusEvents,
          wakeUpJobs: [],
          workflowId: command.workflowId,
        }),
      };
    }),
  );
}

function repositoryTransaction<A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const sqlClient = yield* SqlClient.SqlClient;
    return yield* sqlClient.withTransaction(effect);
  }).pipe(
    Effect.mapError(
      (cause): RuntimeRepositoryFailure => ({
        _tag: "RuntimeRepositoryFailure",
        cause,
        operation,
      }),
    ),
  );
}

function buildCommittedPlanResult(
  committedTasks: readonly CommittedPlanTask[],
  nodeRunById: ReadonlyMap<string, NodeRunIdentity>,
): CommitWorkflowRunPlanResult {
  return {
    executionJobs: committedTasks.flatMap((task) => {
      if (task.status !== "QUEUED") {
        return [];
      }
      const nodeRun = requireNodeRunIdentity(nodeRunById, task.nodeRunId);
      return buildRuntimeExecutionJobPayload({
        branchIndex: task.branchIndex,
        nodeRunId: task.nodeRunId,
        ownerUserId: nodeRun.ownerUserId,
        taskId: task.id,
        workflowId: nodeRun.workflowId,
      });
    }),
    taskStatusEvents: committedTasks.map((task) =>
      buildTaskStatusEvent({
        ...(task.failureReason ? { failureReason: task.failureReason } : {}),
        branchIndex: task.branchIndex,
        nodeRunId: task.nodeRunId,
        status: task.status,
        taskId: task.id,
      }),
    ),
    wakeUpJobs: committedTasks.flatMap((task) => {
      if (task.status !== "FAILED") {
        return [];
      }
      const nodeRun = requireNodeRunIdentity(nodeRunById, task.nodeRunId);
      return buildRuntimeWakeUpJobPayload({
        ownerUserId: nodeRun.ownerUserId,
        parentTaskId: task.id,
        workflowId: nodeRun.workflowId,
      });
    }),
  };
}

function debitTaskCreditsEffect(command: {
  readonly amount: number;
  readonly ownerUserId: string;
  readonly taskId: string;
  readonly workflowId: string;
}) {
  return Effect.gen(function* () {
    if (command.amount <= 0) {
      return { debited: true as const };
    }
    const db = yield* PgDrizzle.PgDrizzle;
    const balance = yield* lockUserAndReadBalanceEffect(command.ownerUserId);
    const sourceKey = buildTaskCreditLedgerSourceKey({
      operation: "debit",
      taskId: command.taskId,
    });
    if (yield* hasLedgerEntryEffect(sourceKey)) {
      return { debited: true as const };
    }
    if (balance < command.amount) {
      return {
        debited: false as const,
        reason: "INSUFFICIENT_CREDITS" as const,
      };
    }
    const [updated] = yield* db
      .update(schema.user)
      .set({
        creditBalance: sql`${schema.user.creditBalance} - ${command.amount}`,
      })
      .where(sql`${schema.user.id} = ${command.ownerUserId}`)
      .returning({ creditBalance: schema.user.creditBalance });
    if (!updated) {
      return yield* Effect.fail(
        new TypeError(`Missing owner user ${command.ownerUserId}`),
      );
    }
    yield* db.insert(schema.creditLedgerEntries).values({
      amount: command.amount,
      balanceAfter: requireNumber(updated.creditBalance),
      executionId: command.workflowId,
      id: sourceKey,
      kind: "debit",
      reason: "task_debit",
      sourceKey,
      userId: command.ownerUserId,
    });
    return { debited: true as const };
  });
}

function refundTaskCreditsEffect(command: {
  readonly amount: number;
  readonly ownerUserId: string;
  readonly taskId: string;
  readonly workflowId: string;
}) {
  return Effect.gen(function* () {
    if (command.amount <= 0) {
      return;
    }
    const db = yield* PgDrizzle.PgDrizzle;
    const sourceKey = buildTaskCreditLedgerSourceKey({
      operation: "refund",
      taskId: command.taskId,
    });
    yield* lockUserAndReadBalanceEffect(command.ownerUserId);
    if (yield* hasLedgerEntryEffect(sourceKey)) {
      return;
    }
    const [updated] = yield* db
      .update(schema.user)
      .set({
        creditBalance: sql`${schema.user.creditBalance} + ${command.amount}`,
      })
      .where(sql`${schema.user.id} = ${command.ownerUserId}`)
      .returning({ creditBalance: schema.user.creditBalance });
    if (!updated) {
      return yield* Effect.fail(
        new TypeError(`Missing owner user ${command.ownerUserId}`),
      );
    }
    yield* db.insert(schema.creditLedgerEntries).values({
      amount: command.amount,
      balanceAfter: requireNumber(updated.creditBalance),
      executionId: command.workflowId,
      id: sourceKey,
      kind: "refund",
      reason: "task_refund",
      sourceKey,
      userId: command.ownerUserId,
    });
  });
}

function adjustTaskCostCreditsEffect(command: {
  readonly amount: number;
  readonly ownerUserId: string;
  readonly taskId: string;
  readonly workflowId: string;
}) {
  return Effect.gen(function* () {
    if (command.amount <= 0) {
      return { adjusted: false as const, amount: 0 as const };
    }
    const db = yield* PgDrizzle.PgDrizzle;
    const sourceKey = buildTaskCreditLedgerSourceKey({
      operation: "cost_adjustment",
      taskId: command.taskId,
    });
    const balance = yield* lockUserAndReadBalanceEffect(command.ownerUserId);
    if (yield* hasLedgerEntryEffect(sourceKey)) {
      return { adjusted: false as const, amount: 0 as const };
    }
    const cappedAmount = Math.min(command.amount, balance);
    if (cappedAmount <= 0) {
      return { adjusted: false as const, amount: 0 as const };
    }
    const [updated] = yield* db
      .update(schema.user)
      .set({
        creditBalance: sql`${schema.user.creditBalance} - ${cappedAmount}`,
      })
      .where(sql`${schema.user.id} = ${command.ownerUserId}`)
      .returning({ creditBalance: schema.user.creditBalance });
    if (!updated) {
      return yield* Effect.fail(
        new TypeError(`Missing owner user ${command.ownerUserId}`),
      );
    }
    yield* db.insert(schema.creditLedgerEntries).values({
      amount: cappedAmount,
      balanceAfter: requireNumber(updated.creditBalance),
      executionId: command.workflowId,
      id: sourceKey,
      kind: "debit",
      reason: "task_cost_adjustment",
      sourceKey,
      userId: command.ownerUserId,
    });
    return { adjusted: true as const, amount: cappedAmount };
  });
}

function lockUserAndReadBalanceEffect(ownerUserId: string) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const rows = yield* db
      .select({ creditBalance: schema.user.creditBalance })
      .from(schema.user)
      .where(sql`${schema.user.id} = ${ownerUserId}`)
      .for("update")
      .limit(1);
    const row = rows[0];
    if (!row) {
      return yield* Effect.fail(
        new TypeError(`Missing owner user ${ownerUserId}`),
      );
    }
    return requireNumber(row.creditBalance);
  });
}

function hasLedgerEntryEffect(sourceKey: string) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const rows = yield* db
      .select({ id: schema.creditLedgerEntries.id })
      .from(schema.creditLedgerEntries)
      .where(sql`${schema.creditLedgerEntries.sourceKey} = ${sourceKey}`)
      .limit(1);
    return rows.length > 0;
  });
}

function insertGeneratedAssetEffect(input: {
  readonly asset: RuntimeGeneratedPrimaryAssetPayload;
  readonly ownerUserId: string;
  readonly taskId: string;
  readonly workflowId: string;
}) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const { asset } = input;
    yield* db.insert(schema.assets).values({
      cdnUrl: "cdnUrl" in asset ? asset.cdnUrl : null,
      externalUri: asset.externalUri ?? null,
      fileName: asset.fileName,
      id: asset.assetId,
      kind: asset.kind,
      mimeType: asset.contentType,
      model: asset.model ?? null,
      ownerUserId: input.ownerUserId,
      sizeBytes: asset.sizeBytes,
      source: "generated",
      storageKey: asset.storageKey ?? null,
      storageProvider: asset.storageProvider,
      taskId: input.taskId,
      textContent: "text" in asset ? asset.text : null,
      workflowId: input.workflowId,
    });
  });
}

function runWakeUpTaskChildrenPersistenceEffect(
  command: WakeUpTaskChildrenRepositoryCommand & {
    readonly workflowId: string;
  },
) {
  return Effect.gen(function* () {
    if (!(yield* wakeUpParentExistsEffect(command))) {
      return { executionJobs: [], parentFound: false, taskStatusEvents: [] };
    }
    const initialState = yield* loadWakeUpGatekeeperStateEffect(command);

    const gatekeeperResult = wakeUpTaskChildren(initialState, {
      settledParentTaskId: command.settledParentTaskId,
    });
    const debitAdjustedResult = yield* applyWakeUpTaskDebitsEffect(
      command,
      gatekeeperResult,
    );
    const durableStateChanged = yield* persistWakeUpGatekeeperResultEffect(
      initialState,
      debitAdjustedResult.state,
    );

    return {
      durableStateChanged,
      executionJobs: buildWakeUpExecutionJobs(
        command,
        debitAdjustedResult.state,
        debitAdjustedResult.executionJobs.map((job) => job.taskId),
      ),
      parentFound: true,
      taskStatusEvents: debitAdjustedResult.taskStatusEvents,
    };
  });
}

function wakeUpParentExistsEffect(
  command: WakeUpTaskChildrenRepositoryCommand & {
    readonly workflowId: string;
  },
) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const rows = yield* db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(sql`${schema.tasks.id} = ${command.settledParentTaskId}
        and ${schema.tasks.ownerUserId} = ${command.ownerUserId}
        and ${schema.tasks.workflowId} = ${command.workflowId}
        and ${schema.tasks.runtimeStatus} is not null`)
      .limit(1);
    return rows.length > 0;
  });
}

function loadWakeUpGatekeeperStateEffect(
  command: WakeUpTaskChildrenRepositoryCommand & {
    readonly workflowId: string;
  },
) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const balance = yield* lockUserAndReadBalanceEffect(command.ownerUserId);
    const taskRows = yield* db
      .select({
        creditCost: schema.tasks.creditCost,
        failureReason: schema.tasks.failureReason,
        inputSnapshot: schema.tasks.inputSnapshot,
        branchIndex: schema.tasks.branchIndex,
        nodeId: schema.tasks.nodeId,
        nodeRunId: schema.tasks.nodeRunId,
        runtimeStatus: schema.tasks.runtimeStatus,
        taskId: schema.tasks.id,
      })
      .from(schema.tasks)
      .where(sql`${schema.tasks.ownerUserId} = ${command.ownerUserId}
        and ${schema.tasks.workflowId} = ${command.workflowId}
        and ${schema.tasks.runtimeStatus} is not null`)
      .orderBy(
        schema.tasks.nodeRunId,
        schema.tasks.branchIndex,
        schema.tasks.createdAt,
        schema.tasks.id,
      )
      .for("update");
    const assetRows = yield* db
      .select({
        assetCdnUrl: schema.assets.cdnUrl,
        assetCreatedAt: schema.assets.createdAt,
        assetExternalUri: schema.assets.externalUri,
        assetFileName: schema.assets.fileName,
        assetId: schema.assets.id,
        assetKind: schema.assets.kind,
        assetMimeType: schema.assets.mimeType,
        assetModel: schema.assets.model,
        assetSizeBytes: schema.assets.sizeBytes,
        assetStorageKey: schema.assets.storageKey,
        assetText: schema.assets.textContent,
        taskId: schema.assets.taskId,
      })
      .from(schema.assets)
      .innerJoin(
        schema.tasks,
        sql`${schema.tasks.id} = ${schema.assets.taskId}`,
      )
      .where(sql`${schema.tasks.ownerUserId} = ${command.ownerUserId}
        and ${schema.tasks.workflowId} = ${command.workflowId}`)
      .orderBy(schema.assets.id);
    const assetsByTaskId = new Map(assetRows.map((row) => [row.taskId, row]));
    const tasksById = new Map<string, TaskGatekeeperTask>();
    for (const row of taskRows) {
      if (tasksById.has(row.taskId)) {
        continue;
      }
      const assetRow = assetsByTaskId.get(row.taskId);
      const asset = assetRow ? buildWorkflowAssetFromRow(assetRow) : null;
      const output = assetRow ? buildRenderableOutputFromRow(assetRow) : null;
      tasksById.set(row.taskId, {
        creditCost: requireNumber(row.creditCost),
        ...(asset ? { asset } : {}),
        ...(row.failureReason
          ? {
              failureReason: taskFailureReasonFromDatabase(row.failureReason),
            }
          : {}),
        id: row.taskId,
        inputSnapshot:
          optionalTaskInputSnapshot(row.inputSnapshot) ?? undefined,
        branchIndex: requireNumber(row.branchIndex),
        nodeRunId: row.nodeRunId,
        nodeId: row.nodeId,
        ...(output ? { output } : {}),
        status: requireTaskRuntimeStatus(row.runtimeStatus),
      });
    }

    const dependencies = yield* db
      .select({
        childTaskId: schema.taskDependencies.childTaskId,
        requiredParentBranchIndex:
          schema.taskDependencies.requiredParentBranchIndex,
        requiredParentNodeRunId:
          schema.taskDependencies.requiredParentNodeRunId,
        requiredParentNodeId: schema.taskDependencies.requiredParentNodeId,
        resolvedParentTaskId: schema.taskDependencies.resolvedParentTaskId,
        sourceHandle: schema.taskDependencies.sourceHandle,
        targetHandle: schema.taskDependencies.targetHandle,
        targetNodeId: schema.taskDependencies.targetNodeId,
      })
      .from(schema.taskDependencies)
      .innerJoin(
        schema.tasks,
        sql`${schema.tasks.id} = ${schema.taskDependencies.childTaskId}`,
      )
      .where(sql`${schema.tasks.ownerUserId} = ${command.ownerUserId}
        and ${schema.tasks.workflowId} = ${command.workflowId}
        and ${schema.tasks.runtimeStatus} is not null`)
      .orderBy(schema.taskDependencies.id);

    return {
      creditBalance: balance,
      dependencies: dependencies.map((dependency) => ({
        childTaskId: dependency.childTaskId,
        requiredParentBranchIndex: requireNumber(
          dependency.requiredParentBranchIndex,
        ),
        requiredParentNodeRunId: dependency.requiredParentNodeRunId,
        requiredParentNodeId: dependency.requiredParentNodeId,
        resolvedParentTaskId: dependency.resolvedParentTaskId,
        sourceHandle: dependency.sourceHandle,
        targetHandle: dependency.targetHandle,
        targetNodeId: dependency.targetNodeId,
      })),
      tasks: Array.from(tasksById.values()),
    } satisfies TaskGatekeeperState;
  });
}

function applyWakeUpTaskDebitsEffect(
  command: WakeUpTaskChildrenRepositoryCommand & {
    readonly workflowId: string;
  },
  gatekeeperResult: ReturnType<typeof wakeUpTaskChildren>,
) {
  return Effect.gen(function* () {
    let nextResult = gatekeeperResult;
    const failedDebitTaskIds = new Set<string>();
    for (const job of gatekeeperResult.executionJobs) {
      const task = requireGatekeeperTask(nextResult.state, job.taskId);
      const debit = yield* debitTaskCreditsEffect({
        amount: task.creditCost,
        ownerUserId: command.ownerUserId,
        taskId: task.id,
        workflowId: command.workflowId,
      });
      if (debit.debited) {
        continue;
      }
      failedDebitTaskIds.add(task.id);
      const failureResult = recordDirectTaskFailure(nextResult.state, {
        failureReason: { type: "INSUFFICIENT_CREDITS" },
        taskId: task.id,
      });
      nextResult = {
        executionJobs: nextResult.executionJobs.filter(
          (candidate) => candidate.taskId !== task.id,
        ),
        state: failureResult.state,
        taskStatusEvents: [
          ...nextResult.taskStatusEvents.filter(
            (event) => !failedDebitTaskIds.has(event.taskId),
          ),
          ...failureResult.taskStatusEvents,
        ],
      };
    }
    return nextResult;
  });
}

function persistWakeUpGatekeeperResultEffect(
  initialState: TaskGatekeeperState,
  nextState: TaskGatekeeperState,
) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const initialTasks = new Map(
      initialState.tasks.map((task) => [task.id, task]),
    );
    let durableStateChanged = false;

    for (const dependency of nextState.dependencies) {
      const initialDependency = initialState.dependencies.find(
        (candidate) =>
          candidate.childTaskId === dependency.childTaskId &&
          candidate.requiredParentNodeRunId ===
            dependency.requiredParentNodeRunId &&
          candidate.requiredParentBranchIndex ===
            dependency.requiredParentBranchIndex &&
          candidate.sourceHandle === dependency.sourceHandle &&
          candidate.targetHandle === dependency.targetHandle,
      );
      if (
        !initialDependency ||
        initialDependency.resolvedParentTaskId ===
          dependency.resolvedParentTaskId
      ) {
        continue;
      }
      const [updated] = yield* db
        .update(schema.taskDependencies)
        .set({
          resolvedAt: new Date(),
          resolvedParentTaskId: dependency.resolvedParentTaskId,
        })
        .where(sql`${schema.taskDependencies.childTaskId} = ${dependency.childTaskId}
          and ${schema.taskDependencies.requiredParentNodeRunId} = ${dependency.requiredParentNodeRunId}
          and ${schema.taskDependencies.requiredParentBranchIndex} = ${dependency.requiredParentBranchIndex}
          and ${schema.taskDependencies.sourceHandle} is not distinct from ${dependency.sourceHandle}
          and ${schema.taskDependencies.targetHandle} is not distinct from ${dependency.targetHandle}
          and ${schema.taskDependencies.resolvedParentTaskId} is null`)
        .returning({ id: schema.taskDependencies.id });
      durableStateChanged = durableStateChanged || Boolean(updated);
    }

    for (const task of nextState.tasks) {
      const initialTask = initialTasks.get(task.id);
      if (!initialTask || !gatekeeperTaskChanged(initialTask, task)) {
        continue;
      }
      const [updated] = yield* db
        .update(schema.tasks)
        .set({
          error:
            task.status === "UPSTREAM_FAILED"
              ? `Upstream Task ${task.failureReason?.type === "UPSTREAM_FAILED" ? task.failureReason.failedParentTaskId : "unknown"} did not approve.`
              : null,
          failedAt:
            task.status === "FAILED" || task.status === "UPSTREAM_FAILED"
              ? new Date()
              : null,
          failureReason: task.failureReason?.type ?? null,
          inputSnapshot: task.inputSnapshot ?? null,
          queuedAt: task.status === "QUEUED" ? new Date() : null,
          runtimeStatus: task.status,
          updatedAt: new Date(),
        })
        .where(sql`${schema.tasks.id} = ${task.id}
          and ${schema.tasks.runtimeStatus} = ${initialTask.status}`)
        .returning({ id: schema.tasks.id });
      durableStateChanged = durableStateChanged || Boolean(updated);
    }

    return durableStateChanged;
  });
}

function buildWakeUpExecutionJobs(
  command: WakeUpTaskChildrenRepositoryCommand & {
    readonly workflowId: string;
  },
  state: TaskGatekeeperState,
  taskIds: readonly string[],
): readonly RuntimeExecutionJobPayload[] {
  return taskIds.map((taskId) => {
    const task = requireGatekeeperTask(state, taskId);
    return buildRuntimeExecutionJobPayload({
      branchIndex: task.branchIndex,
      nodeRunId: task.nodeRunId,
      ownerUserId: command.ownerUserId,
      taskId: task.id,
      workflowId: command.workflowId,
    });
  });
}

function requireGatekeeperTask(
  state: TaskGatekeeperState,
  taskId: string,
): TaskGatekeeperTask {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new TypeError(`Missing gatekeeper Task ${taskId}`);
  }
  return task;
}

function gatekeeperTaskChanged(
  left: TaskGatekeeperTask,
  right: TaskGatekeeperTask,
): boolean {
  return (
    left.status !== right.status ||
    JSON.stringify(left.failureReason ?? null) !==
      JSON.stringify(right.failureReason ?? null) ||
    JSON.stringify(left.inputSnapshot ?? null) !==
      JSON.stringify(right.inputSnapshot ?? null)
  );
}

function taskFailureReasonFromDatabase(value: string): TaskFailureReason {
  if (value === "UPSTREAM_FAILED") {
    return { failedParentTaskId: "unknown", type: "UPSTREAM_FAILED" };
  }
  if (value === "INSUFFICIENT_CREDITS") {
    return { type: "INSUFFICIENT_CREDITS" };
  }
  if (value === "PROVIDER_FAILED") {
    return { message: "Provider failed.", type: "PROVIDER_FAILED" };
  }
  return { message: "Execution failed.", type: "EXECUTION_FAILED" };
}

function resolveApprovedDependenciesForChildEffect(childTaskId: string) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const dependencies = yield* db
      .select({
        id: schema.taskDependencies.id,
        parentBranchIndex: schema.taskDependencies.requiredParentBranchIndex,
        parentNodeRunId: schema.taskDependencies.requiredParentNodeRunId,
      })
      .from(schema.taskDependencies)
      .where(sql`${schema.taskDependencies.childTaskId} = ${childTaskId}
        and ${schema.taskDependencies.resolvedParentTaskId} is null`)
      .orderBy(schema.taskDependencies.id);
    for (const dependency of dependencies) {
      const [parent] = yield* db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(sql`${schema.tasks.nodeRunId} = ${dependency.parentNodeRunId}
          and ${schema.tasks.branchIndex} = ${dependency.parentBranchIndex}
          and ${schema.tasks.runtimeStatus} = 'APPROVED'`)
        .orderBy(sql`${schema.tasks.createdAt} desc`, schema.tasks.id)
        .limit(1);
      if (!parent) {
        continue;
      }
      yield* db
        .update(schema.taskDependencies)
        .set({
          resolvedAt: new Date(),
          resolvedParentTaskId: parent.id,
        })
        .where(sql`${schema.taskDependencies.id} = ${dependency.id}`);
    }
  });
}

function loadResolvedParentSnapshotsEffect(childTaskId: string) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const rows = yield* db
      .select({
        assetCdnUrl: schema.assets.cdnUrl,
        assetCreatedAt: schema.assets.createdAt,
        assetExternalUri: schema.assets.externalUri,
        assetFileName: schema.assets.fileName,
        assetId: schema.assets.id,
        assetKind: schema.assets.kind,
        assetMimeType: schema.assets.mimeType,
        assetModel: schema.assets.model,
        assetSizeBytes: schema.assets.sizeBytes,
        assetStorageKey: schema.assets.storageKey,
        assetText: schema.assets.textContent,
        branchIndex: schema.tasks.branchIndex,
        nodeRunId: schema.tasks.nodeRunId,
        parentBranchIndex: schema.taskDependencies.requiredParentBranchIndex,
        parentNodeId: schema.taskDependencies.requiredParentNodeId,
        sourceHandle: schema.taskDependencies.sourceHandle,
        targetHandle: schema.taskDependencies.targetHandle,
        targetNodeId: schema.taskDependencies.targetNodeId,
        taskId: schema.tasks.id,
      })
      .from(schema.taskDependencies)
      .innerJoin(
        schema.tasks,
        sql`${schema.tasks.id} = ${schema.taskDependencies.resolvedParentTaskId}`,
      )
      .leftJoin(
        schema.assets,
        sql`${schema.assets.taskId} = ${schema.tasks.id}`,
      )
      .where(sql`${schema.taskDependencies.childTaskId} = ${childTaskId}`)
      .orderBy(schema.taskDependencies.id, schema.assets.id);
    return rows.map((row) => {
      const asset = buildWorkflowAssetFromRow(row);
      const output = buildRenderableOutputFromRow(row);
      return {
        ...(asset ? { asset } : {}),
        address: {
          parentBranchIndex: requireNumber(row.parentBranchIndex),
          parentNodeId: row.parentNodeId,
          sourceHandle: row.sourceHandle,
          targetHandle: row.targetHandle,
          targetNodeId: row.targetNodeId,
        },
        branchIndex: requireNumber(row.branchIndex),
        nodeRunId: row.nodeRunId,
        ...(output ? { output } : {}),
        taskId: row.taskId,
      };
    });
  });
}

function buildRenderableOutputFromRow(row: {
  readonly assetCdnUrl: string | null;
  readonly assetId: string | null;
  readonly assetKind: WorkflowAsset["kind"] | null;
  readonly assetMimeType: string | null;
  readonly assetText: string | null;
}) {
  if (!row.assetId || !row.assetKind || !row.assetMimeType) {
    return null;
  }
  if (row.assetKind === "text") {
    return {
      assetId: row.assetId,
      kind: "inline-text-asset" as const,
      text: row.assetText ?? "",
    };
  }
  if (!row.assetCdnUrl) {
    return null;
  }
  return {
    assetId: row.assetId,
    cdnUrl: row.assetCdnUrl,
    contentType: row.assetMimeType,
    kind: "cdn-asset" as const,
  };
}

function buildWorkflowAssetFromRow(row: {
  readonly assetCdnUrl: string | null;
  readonly assetCreatedAt: Date | null;
  readonly assetExternalUri: string | null;
  readonly assetFileName: string | null;
  readonly assetId: string | null;
  readonly assetKind: WorkflowAsset["kind"] | null;
  readonly assetMimeType: string | null;
  readonly assetModel: string | null;
  readonly assetSizeBytes: number | null;
  readonly assetStorageKey: string | null;
}): WorkflowAsset | null {
  if (
    !row.assetId ||
    !row.assetFileName ||
    !row.assetKind ||
    !row.assetMimeType ||
    !row.assetCdnUrl
  ) {
    return null;
  }
  return {
    createdAt: row.assetCreatedAt?.toISOString() ?? "",
    externalUri: row.assetExternalUri,
    fileName: row.assetFileName,
    id: row.assetId,
    kind: row.assetKind,
    mimeType: row.assetMimeType,
    model: row.assetModel,
    size: Number(row.assetSizeBytes ?? 0),
    source: "generated",
    storagePath: row.assetStorageKey,
    url: row.assetCdnUrl,
  };
}

function loadTaskRuntimeStatusEffect(command: DecideTaskReviewCommand) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const rows = yield* db
      .select({ runtimeStatus: schema.tasks.runtimeStatus })
      .from(schema.tasks)
      .where(sql`${schema.tasks.id} = ${command.taskId}
        and ${schema.tasks.ownerUserId} = ${command.ownerUserId}
`)
      .for("update")
      .limit(1);
    return rows[0]?.runtimeStatus ?? null;
  });
}

function getRuntimeTasksForNodeRunEffect(command: {
  readonly nodeRunId: string;
  readonly ownerUserId: string;
}) {
  return repositoryTransaction(
    "getRuntimeTasksForNodeRun",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const rows = yield* db
        .select({
          inputSnapshot: schema.tasks.inputSnapshot,
          branchIndex: schema.tasks.branchIndex,
          nodeRunId: schema.tasks.nodeRunId,
          ownerUserId: schema.tasks.ownerUserId,
          runtimeStatus: schema.tasks.runtimeStatus,
          taskId: schema.tasks.id,
          workflowId: schema.tasks.workflowId,
        })
        .from(schema.tasks)
        .where(sql`${schema.tasks.nodeRunId} = ${command.nodeRunId}
          and ${schema.tasks.ownerUserId} = ${command.ownerUserId}
          and ${schema.tasks.runtimeStatus} is not null`)
        .orderBy(schema.tasks.branchIndex, schema.tasks.id);
      return rows.map((row) => ({
        inputSnapshot: optionalTaskInputSnapshot(row.inputSnapshot) ?? null,
        branchIndex: requireNumber(row.branchIndex),
        nodeRunId: row.nodeRunId,
        ownerUserId: row.ownerUserId,
        runtimeStatus: requireTaskRuntimeStatus(row.runtimeStatus),
        taskId: row.taskId,
        workflowId: row.workflowId,
      }));
    }),
  );
}

function getTaskDependenciesForChildEffect(command: {
  readonly childTaskId: string;
}) {
  return repositoryTransaction(
    "getTaskDependenciesForChild",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const rows = yield* db
        .select({
          childTaskId: schema.taskDependencies.childTaskId,
          requiredParentBranchIndex:
            schema.taskDependencies.requiredParentBranchIndex,
          requiredParentNodeRunId:
            schema.taskDependencies.requiredParentNodeRunId,
          requiredParentNodeId: schema.taskDependencies.requiredParentNodeId,
          resolvedParentTaskId: schema.taskDependencies.resolvedParentTaskId,
          sourceHandle: schema.taskDependencies.sourceHandle,
          targetHandle: schema.taskDependencies.targetHandle,
          targetNodeId: schema.taskDependencies.targetNodeId,
        })
        .from(schema.taskDependencies)
        .where(
          sql`${schema.taskDependencies.childTaskId} = ${command.childTaskId}`,
        )
        .orderBy(
          schema.taskDependencies.requiredParentNodeRunId,
          schema.taskDependencies.requiredParentBranchIndex,
        );
      return rows;
    }),
  );
}

function getCreditLedgerForUserEffect(command: {
  readonly ownerUserId: string;
}) {
  return repositoryTransaction(
    "getCreditLedgerForUser",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const [userRow] = yield* db
        .select({ creditBalance: schema.user.creditBalance })
        .from(schema.user)
        .where(sql`${schema.user.id} = ${command.ownerUserId}`)
        .limit(1);
      const ledgerRows = yield* db
        .select({
          amount: schema.creditLedgerEntries.amount,
          balanceAfter: schema.creditLedgerEntries.balanceAfter,
          kind: schema.creditLedgerEntries.kind,
          sourceKey: schema.creditLedgerEntries.sourceKey,
        })
        .from(schema.creditLedgerEntries)
        .where(
          sql`${schema.creditLedgerEntries.userId} = ${command.ownerUserId}`,
        )
        .orderBy(
          schema.creditLedgerEntries.createdAt,
          schema.creditLedgerEntries.id,
        );
      return {
        creditBalance: requireNumber(userRow?.creditBalance),
        ledgerEntries: ledgerRows.map((row) => ({
          amount: requireNumber(row.amount),
          balanceAfter: requireNumber(row.balanceAfter),
          kind: requireString(row.kind),
          sourceKey: requireString(row.sourceKey),
        })),
      };
    }),
  );
}

function countPlannedTasksForNodeRun(plan: WorkflowRunPlan, nodeRunId: string) {
  return plan.tasksToCreate.filter((task) => task.nodeRunId === nodeRunId)
    .length;
}

function staleTaskTransition(
  command: { readonly taskId: string },
  operation: string,
) {
  return Effect.fail({
    _tag: "StaleTaskTransition",
    operation,
    taskId: command.taskId,
  } satisfies StaleTaskTransition);
}

function committedOutcome<T>(
  value: T,
  postCommitWork: PostCommitWork,
): RepositoryCommittedOutcome<T> {
  return { postCommitWork, value };
}

function emptyPostCommitWork(
  source: PostCommitWorkSource,
  workflowId: string,
): PostCommitWork {
  return {
    executionJobs: [],
    source,
    taskStatusEvents: [],
    wakeUpJobs: [],
    workflowId,
  };
}

function workflowIdFromNodeRuns(
  nodeRunById: ReadonlyMap<string, NodeRunIdentity>,
): string {
  const workflowId = nodeRunById.values().next().value?.workflowId;
  if (!workflowId) {
    throw new TypeError(
      "Workflow Run plan has no transaction-local workflow id",
    );
  }

  return workflowId;
}

function buildRepositoryInputSnapshot(input: {
  readonly documentRevision?: number | null;
  readonly branchIndex: number;
  readonly nodeRunId: string;
  readonly nodeId: string;
  readonly resolvedParents: readonly ResolvedParentTaskSnapshot[] | null;
  readonly targetNodeConfig: TaskInputSnapshot["targetNodeConfig"];
  readonly taskId: string;
  readonly workflowDefinition: TaskInputSnapshot["workflowDefinition"];
}): TaskInputSnapshot {
  return buildTaskInputSnapshot({
    documentRevision: input.documentRevision,
    branchIndex: input.branchIndex,
    nodeRunId: input.nodeRunId,
    nodeId: input.nodeId,
    resolvedParentTasks: input.resolvedParents ?? [],
    targetNodeConfig: input.targetNodeConfig,
    taskId: input.taskId,
    workflowDefinition: input.workflowDefinition,
  });
}

function requireNodeRunIdentity(
  nodeRunById: ReadonlyMap<string, NodeRunIdentity>,
  nodeRunId: string,
) {
  const nodeRun = nodeRunById.get(nodeRunId);
  if (!nodeRun) {
    throw new TypeError(`Missing Node Run ${nodeRunId}`);
  }

  return nodeRun;
}

function buildTaskDependencyId(input: {
  readonly childTaskId: string;
  readonly parentNodeRunId: string;
  readonly parentBranchIndex: number;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
}) {
  return [
    input.childTaskId,
    input.parentNodeRunId,
    input.parentBranchIndex,
    input.sourceHandle ?? "",
    input.targetHandle ?? "",
  ].join(":");
}

function taskCostAdjustmentCredits(
  creditCost: number,
  providerCostCredits: number,
): number {
  return Math.ceil(Math.max(providerCostCredits - creditCost, 0));
}

function blockedCancelResult(status: string | null): CancelTaskResult {
  if (status === "RUNNING") {
    return {
      blocked: true,
      decided: false,
      message: "Running Tasks cannot be cancelled.",
      reason: "RUNNING_TASK_RUN_CANCELLATION_BLOCKED",
    };
  }

  if (status === "PENDING_REVIEW") {
    return {
      blocked: true,
      decided: false,
      message:
        "Pending Review Tasks must be approved or rejected instead of cancelled.",
      reason: "PENDING_REVIEW_REQUIRES_REVIEW_DECISION",
    };
  }

  return { decided: false };
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Expected non-empty database string value");
  }

  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  throw new TypeError("Expected integer database number value");
}

function requireTaskRuntimeStatus(
  value: unknown,
): RuntimeTaskRow["runtimeStatus"] {
  if (
    value === "WAITING_UPSTREAM" ||
    value === "QUEUED" ||
    value === "RUNNING" ||
    value === "PENDING_REVIEW" ||
    value === "APPROVED" ||
    value === "REJECTED" ||
    value === "CANCELLED" ||
    value === "FAILED" ||
    value === "UPSTREAM_FAILED"
  ) {
    return value;
  }

  throw new TypeError("Expected task runtime status value");
}

function requireTaskInputSnapshot(value: unknown): TaskInputSnapshot {
  if (!isTaskInputSnapshot(value)) {
    throw new TypeError("Expected task input snapshot database value");
  }

  return value;
}

function requireExecutableTaskInputSnapshot(
  value: unknown,
): ExecutableTaskInputSnapshot {
  const snapshot = requireTaskInputSnapshot(value);
  if (snapshot.providerInput.kind === "non-executable-node") {
    throw new TypeError(
      "Expected executable task input snapshot database value",
    );
  }

  return { ...snapshot, providerInput: snapshot.providerInput };
}

function optionalTaskInputSnapshot(value: unknown): TaskInputSnapshot | null {
  return value === null ? null : requireTaskInputSnapshot(value);
}
