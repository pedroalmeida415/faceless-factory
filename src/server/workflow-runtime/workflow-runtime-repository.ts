import { SqlClient } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { inArray, sql } from "drizzle-orm";
import { Effect, type Layer } from "effect";
import type { WorkflowAsset } from "~/lib/workflow/types";
import { projectGeneratedAssetToTaskOutput } from "~/lib/workflow-runtime/assets/generated-asset-projection";
import type {
  TaskRunFailureReason,
  TaskRunSettlementFailureSource,
} from "~/lib/workflow-runtime/domain/task-run-state";
import {
  buildTaskRunInputSnapshot,
  type ExecutableTaskRunInputSnapshot,
  isTaskRunInputSnapshot,
  type TaskRunInputSnapshot,
} from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
import {
  recordDirectTaskRunFailure,
  type TaskRunGatekeeperState,
  type TaskRunGatekeeperTaskRun,
  wakeUpTaskRunChildren,
} from "~/lib/workflow-runtime/gatekeeper/task-run-gatekeeper";
import type { WorkflowRunPlan } from "~/lib/workflow-runtime/planning/workflow-run-planner";
import {
  buildTaskStatusEvent,
  type TaskStatusEvent,
} from "~/lib/workflow-runtime/runtime/task-status-events";
import type { taskRuns } from "~/server/db/schema";
import * as schema from "~/server/db/schema";
import { promoteStagedGeneratedArtifact } from "~/server/workflow/storage";
import { buildTaskRunCreditLedgerSourceKey } from "~/server/workflow-runtime/task-run-credit-ledger";
import type {
  PostCommitWork,
  PostCommitWorkSource,
} from "~/server/workflow-runtime/workflow-runtime-post-commit-work";
import {
  buildWorkflowRuntimeExecutionJobPayload,
  buildWorkflowRuntimeWakeUpJobPayload,
  type WorkflowRuntimeExecutionJobPayload,
  type WorkflowRuntimeGeneratedPrimaryAssetPayload,
  type WorkflowRuntimeWakeUpJobPayload,
} from "~/server/workflow-runtime/workflow-runtime-queue";

type ClaimQueuedTaskRunCommand = {
  readonly taskRunId: string;
  readonly ownerUserId: string;
  readonly attempt: number;
};

type ClaimQueuedTaskRunResult =
  | {
      readonly claimed: true;
      readonly event: TaskStatusEvent;
      readonly inputSnapshot: ExecutableTaskRunInputSnapshot;
    }
  | { readonly claimed: false };

type SettleTaskRunCompletionCommand = {
  readonly attempt: number;
  readonly providerCostCredits: number;
  readonly generatedAsset: WorkflowRuntimeGeneratedPrimaryAssetPayload;
  readonly ownerUserId: string;
  readonly reviewRequired: boolean;
  readonly taskRunId: string;
  readonly workflowId: string;
};

type SettleTaskRunCompletionResult =
  | {
      readonly settled: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload | null;
    }
  | { readonly settled: false };

type SettleTaskRunFailureCommand = {
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

type SettleTaskRunFailureResult =
  | {
      readonly settled: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload;
    }
  | { readonly settled: false };

type DecideTaskRunReviewCommand = {
  readonly attempt: number;
  readonly ownerUserId: string;
  readonly taskRunId: string;
};

type RejectTaskRunAndCreateRegenerationCommand = DecideTaskRunReviewCommand & {
  readonly newTaskRunId: string;
};

type ReviewDecisionResult =
  | {
      readonly decided: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload;
    }
  | { readonly decided: false };

type RejectTaskRunResult =
  | {
      readonly executionJob: WorkflowRuntimeExecutionJobPayload | null;
      readonly rejected: true;
      readonly taskStatusEvents: readonly TaskStatusEvent[];
    }
  | { readonly rejected: false };

type CancelTaskRunBlockedReason =
  | "PENDING_REVIEW_REQUIRES_REVIEW_DECISION"
  | "RUNNING_TASK_RUN_CANCELLATION_BLOCKED";

type CancelTaskRunResult =
  | {
      readonly decided: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload;
    }
  | { readonly decided: false }
  | {
      readonly blocked: true;
      readonly decided: false;
      readonly message: string;
      readonly reason: CancelTaskRunBlockedReason;
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
  readonly childTaskRunId: string;
  readonly requiredParentItemIndex: number;
  readonly requiredParentNodeExecutionId: string;
  readonly requiredParentNodeId: string;
  readonly resolvedParentTaskRunId: string | null;
  readonly sourceHandle: string | null;
  readonly targetHandle: string | null;
  readonly targetNodeId: string;
};

export type WakeUpTaskRunChildrenRepositoryCommand = {
  readonly ownerUserId: string;
  readonly settledParentTaskRunId: string;
};

export type WakeUpTaskRunChildrenRepositoryResult = {
  readonly executionJobs: readonly WorkflowRuntimeExecutionJobPayload[];
  readonly parentFound: boolean;
  readonly taskStatusEvents: readonly TaskStatusEvent[];
};

type CommitWorkflowRunPlanResult = {
  readonly executionJobs: readonly WorkflowRuntimeExecutionJobPayload[];
  readonly taskStatusEvents: readonly TaskStatusEvent[];
  readonly wakeUpJobs: readonly WorkflowRuntimeWakeUpJobPayload[];
};

export type RepositoryCommittedOutcome<T> = {
  readonly durableStateChanged?: boolean;
  readonly postCommitWork: PostCommitWork;
  readonly value: T;
};

export type StaleTaskRunTransition = {
  readonly _tag: "StaleTaskRunTransition";
  readonly attempt: number;
  readonly operation: string;
  readonly taskRunId: string;
};

export type WakeUpParentNotFound = {
  readonly _tag: "WakeUpParentNotFound";
  readonly ownerUserId: string;
  readonly settledParentTaskRunId: string;
};

export type WorkflowRuntimeRepositoryFailure =
  | StaleTaskRunTransition
  | WakeUpParentNotFound
  | {
      readonly _tag: "WorkflowRuntimeRepositoryFailure";
      readonly cause: unknown;
      readonly operation: string;
    };

type CommittedPlanTaskRun = Omit<
  WorkflowRunPlan["taskRunsToCreate"][number],
  "failureReason" | "status"
> & {
  readonly failureReason?: "EXECUTION_FAILED" | "INSUFFICIENT_CREDITS";
  readonly status: "FAILED" | "QUEUED" | "WAITING_UPSTREAM";
};

type RuntimeTaskRunRow = {
  readonly attempt: number;
  readonly inputSnapshot: TaskRunInputSnapshot | null;
  readonly itemIndex: number;
  readonly nodeExecutionId: string;
  readonly ownerUserId: string;
  readonly runtimeStatus: NonNullable<
    (typeof taskRuns.$inferSelect)["runtimeStatus"]
  >;
  readonly taskRunId: string;
  readonly workflowId: string;
};

type ResolvedParentTaskRunSnapshot =
  TaskRunInputSnapshot["resolvedParentTaskRuns"][number];

type NodeExecutionIdentity = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly workflowId: string;
};

type WorkflowRuntimeRepositorySqlServices =
  | SqlClient.SqlClient
  | PgDrizzle.PgDrizzle;

type WorkflowRuntimeRepositoryOptions = {
  readonly sqlLayer?: Layer.Layer<
    WorkflowRuntimeRepositorySqlServices,
    WorkflowRuntimeRepositoryFailure
  >;
};

type WorkflowRuntimeRepository<R> = {
  readonly approveTaskRun: (
    command: DecideTaskRunReviewCommand & { workflowId: string },
  ) => Effect.Effect<
    RepositoryCommittedOutcome<
      Extract<ReviewDecisionResult, { decided: true }>
    >,
    WorkflowRuntimeRepositoryFailure,
    R
  >;
  readonly cancelTaskRun: (
    command: DecideTaskRunReviewCommand & { workflowId: string },
  ) => Effect.Effect<
    RepositoryCommittedOutcome<CancelTaskRunResult>,
    WorkflowRuntimeRepositoryFailure,
    R
  >;
  readonly claimQueuedTaskRun: (
    command: ClaimQueuedTaskRunCommand,
  ) => Effect.Effect<
    ClaimQueuedTaskRunResult,
    WorkflowRuntimeRepositoryFailure,
    R
  >;
  readonly commitWorkflowRunPlan: (
    plan: WorkflowRunPlan,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<CommitWorkflowRunPlanResult>,
    WorkflowRuntimeRepositoryFailure,
    R
  >;
  readonly getCreditLedgerForUser: (command: {
    readonly ownerUserId: string;
  }) => Effect.Effect<CreditLedgerForUser, WorkflowRuntimeRepositoryFailure, R>;
  readonly getRuntimeTaskRunsForNodeExecution: (command: {
    readonly nodeExecutionId: string;
    readonly ownerUserId: string;
  }) => Effect.Effect<
    readonly RuntimeTaskRunRow[],
    WorkflowRuntimeRepositoryFailure,
    R
  >;
  readonly getTaskDependenciesForChild: (command: {
    readonly childTaskRunId: string;
  }) => Effect.Effect<
    readonly TaskDependencyForChild[],
    WorkflowRuntimeRepositoryFailure,
    R
  >;
  readonly rejectTaskRunAndCreateRegeneration: (
    command: RejectTaskRunAndCreateRegenerationCommand & { workflowId: string },
  ) => Effect.Effect<
    RepositoryCommittedOutcome<
      Extract<RejectTaskRunResult, { rejected: true }>
    >,
    WorkflowRuntimeRepositoryFailure,
    R
  >;
  readonly settleTaskRunCompletion: (
    command: SettleTaskRunCompletionCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<SettleTaskRunCompletionResult>,
    WorkflowRuntimeRepositoryFailure,
    R
  >;
  readonly settleTaskRunFailure: (
    command: SettleTaskRunFailureCommand,
  ) => Effect.Effect<
    RepositoryCommittedOutcome<SettleTaskRunFailureResult>,
    WorkflowRuntimeRepositoryFailure,
    R
  >;
  readonly wakeUpTaskRunChildren: (
    command: WakeUpTaskRunChildrenRepositoryCommand & { workflowId: string },
  ) => Effect.Effect<
    RepositoryCommittedOutcome<WakeUpTaskRunChildrenRepositoryResult>,
    WorkflowRuntimeRepositoryFailure,
    R
  >;
};

export function createWorkflowRuntimeRepository(): WorkflowRuntimeRepository<WorkflowRuntimeRepositorySqlServices>;
export function createWorkflowRuntimeRepository(
  options: Required<WorkflowRuntimeRepositoryOptions>,
): WorkflowRuntimeRepository<never>;
export function createWorkflowRuntimeRepository(
  options: WorkflowRuntimeRepositoryOptions = {},
):
  | WorkflowRuntimeRepository<WorkflowRuntimeRepositorySqlServices>
  | WorkflowRuntimeRepository<never> {
  if (options.sqlLayer) {
    const sqlLayer = options.sqlLayer;
    return buildWorkflowRuntimeRepository((effect) =>
      Effect.provide(effect, sqlLayer),
    );
  }
  return buildWorkflowRuntimeRepository((effect) => effect);
}

function buildWorkflowRuntimeRepository<R>(
  provideSql: <A>(
    effect: Effect.Effect<
      A,
      WorkflowRuntimeRepositoryFailure,
      WorkflowRuntimeRepositorySqlServices
    >,
  ) => Effect.Effect<A, WorkflowRuntimeRepositoryFailure, R>,
): WorkflowRuntimeRepository<R> {
  return {
    commitWorkflowRunPlan: (plan: WorkflowRunPlan) =>
      provideSql(commitWorkflowRunPlanEffect(plan)),
    claimQueuedTaskRun: (command: ClaimQueuedTaskRunCommand) =>
      provideSql(claimQueuedTaskRunEffect(command)),
    settleTaskRunCompletion: (command: SettleTaskRunCompletionCommand) =>
      provideSql(settleTaskRunCompletionEffect(command)).pipe(
        Effect.flatMap((outcome) =>
          outcome.value.settled
            ? Effect.succeed({
                postCommitWork: outcome.postCommitWork,
                value: outcome.value,
              })
            : staleTaskRunTransition(command, "settleTaskRunCompletion"),
        ),
      ),
    settleTaskRunFailure: (command: SettleTaskRunFailureCommand) =>
      provideSql(settleTaskRunFailureEffect(command)).pipe(
        Effect.flatMap((outcome) =>
          outcome.value.settled
            ? Effect.succeed({
                postCommitWork: outcome.postCommitWork,
                value: outcome.value,
              })
            : staleTaskRunTransition(command, "settleTaskRunFailure"),
        ),
      ),
    approveTaskRun: (
      command: DecideTaskRunReviewCommand & { workflowId: string },
    ) =>
      provideSql(approveTaskRunEffect(command)).pipe(
        Effect.flatMap((outcome) =>
          outcome.value.decided
            ? Effect.succeed({
                postCommitWork: outcome.postCommitWork,
                value: outcome.value,
              })
            : staleTaskRunTransition(command, "approveTaskRun"),
        ),
      ),
    cancelTaskRun: (
      command: DecideTaskRunReviewCommand & { workflowId: string },
    ) =>
      provideSql(cancelTaskRunEffect(command)).pipe(
        Effect.flatMap((value) =>
          "blocked" in value.value || value.value.decided
            ? Effect.succeed(value)
            : staleTaskRunTransition(command, "cancelTaskRun"),
        ),
      ),
    rejectTaskRunAndCreateRegeneration: (
      command: RejectTaskRunAndCreateRegenerationCommand & {
        workflowId: string;
      },
    ) =>
      provideSql(rejectTaskRunAndCreateRegenerationEffect(command)).pipe(
        Effect.flatMap((outcome) =>
          outcome.value.rejected
            ? Effect.succeed({
                postCommitWork: outcome.postCommitWork,
                value: outcome.value,
              })
            : staleTaskRunTransition(
                command,
                "rejectTaskRunAndCreateRegeneration",
              ),
        ),
      ),
    wakeUpTaskRunChildren: (
      command: WakeUpTaskRunChildrenRepositoryCommand & { workflowId: string },
    ) =>
      provideSql(wakeUpTaskRunChildrenEffect(command)).pipe(
        Effect.flatMap((value) =>
          value.value.parentFound
            ? Effect.succeed(value)
            : Effect.fail({
                _tag: "WakeUpParentNotFound",
                ownerUserId: command.ownerUserId,
                settledParentTaskRunId: command.settledParentTaskRunId,
              } satisfies WakeUpParentNotFound),
        ),
      ),
    getRuntimeTaskRunsForNodeExecution: (command: {
      readonly nodeExecutionId: string;
      readonly ownerUserId: string;
    }) => provideSql(getRuntimeTaskRunsForNodeExecutionEffect(command)),
    getTaskDependenciesForChild: (command: {
      readonly childTaskRunId: string;
    }) => provideSql(getTaskDependenciesForChildEffect(command)),
    getCreditLedgerForUser: (command: { readonly ownerUserId: string }) =>
      provideSql(getCreditLedgerForUserEffect(command)),
  };
}

function claimQueuedTaskRunEffect(command: ClaimQueuedTaskRunCommand) {
  return repositoryTransaction(
    "claimQueuedTaskRun",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const [row] = yield* db
        .update(schema.taskRuns)
        .set({
          runtimeStatus: "RUNNING",
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(sql`${schema.taskRuns.id} = ${command.taskRunId}
          and ${schema.taskRuns.ownerUserId} = ${command.ownerUserId}
          and ${schema.taskRuns.attempt} = ${command.attempt}
          and ${schema.taskRuns.runtimeStatus} = 'QUEUED'`)
        .returning({
          attempt: schema.taskRuns.attempt,
          inputSnapshot: schema.taskRuns.inputSnapshot,
          itemIndex: schema.taskRuns.itemIndex,
          nodeExecutionId: schema.taskRuns.nodeExecutionId,
          taskRunId: schema.taskRuns.id,
        });

      if (!row) {
        return { claimed: false as const };
      }

      return {
        claimed: true as const,
        event: buildTaskStatusEvent({
          attempt: requireNumber(row.attempt),
          itemIndex: requireNumber(row.itemIndex),
          nodeExecutionId: row.nodeExecutionId,
          status: "RUNNING",
          taskRunId: row.taskRunId,
        }),
        inputSnapshot: requireExecutableTaskRunInputSnapshot(row.inputSnapshot),
      };
    }),
  );
}

function commitWorkflowRunPlanEffect(plan: WorkflowRunPlan) {
  return repositoryTransaction(
    "commitWorkflowRunPlan",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const nodeExecutionById = new Map<string, NodeExecutionIdentity>();

      for (const nodeExecution of plan.nodeExecutionsToCreate) {
        nodeExecutionById.set(nodeExecution.id, {
          id: nodeExecution.id,
          ownerUserId: nodeExecution.ownerId,
          workflowId: nodeExecution.workflowId,
        });
        yield* db.insert(schema.nodeExecutions).values({
          executionId: nodeExecution.id,
          id: nodeExecution.id,
          nodeId: nodeExecution.nodeId,
          outputCount: countPlannedTaskRunsForNodeExecution(
            plan,
            nodeExecution.id,
          ),
          ownerUserId: nodeExecution.ownerId,
          status: "pending",
          targetReason: "node_run",
          workflowId: nodeExecution.workflowId,
        });
      }

      yield* loadMissingNodeExecutionIdentitiesEffect(plan, nodeExecutionById);

      const committedTaskRuns: CommittedPlanTaskRun[] = [];
      for (const taskRun of plan.taskRunsToCreate) {
        const nodeExecution = requireNodeExecutionIdentity(
          nodeExecutionById,
          taskRun.nodeExecutionId,
        );
        const creditCost = taskRun.creditCost;
        const debit =
          taskRun.status === "QUEUED"
            ? yield* debitTaskRunCreditsEffect({
                amount: creditCost,
                ownerUserId: nodeExecution.ownerUserId,
                taskRunId: taskRun.id,
                workflowId: nodeExecution.workflowId,
              })
            : {
                debited: false as const,
                reason: "INSUFFICIENT_CREDITS" as const,
              };
        const hasDebitedCredits = debit.debited;
        const committedTaskRun: CommittedPlanTaskRun =
          taskRun.status !== "QUEUED" || hasDebitedCredits
            ? taskRun
            : {
                ...taskRun,
                failureReason: "INSUFFICIENT_CREDITS",
                status: "FAILED",
              };
        committedTaskRuns.push(committedTaskRun);

        const inputSnapshot =
          committedTaskRun.status === "QUEUED" && hasDebitedCredits
            ? buildRepositoryInputSnapshot({
                attempt: taskRun.attempt,
                itemIndex: taskRun.itemIndex,
                nodeExecutionId: taskRun.nodeExecutionId,
                nodeId: taskRun.nodeId,
                resolvedParents: [],
                targetNodeConfig: taskRun.targetNodeConfig,
                taskRunId: taskRun.id,
                workflowDefinition: plan.workflowDefinition,
              })
            : committedTaskRun.status === "WAITING_UPSTREAM"
              ? (taskRun.inputSnapshot ??
                buildRepositoryInputSnapshot({
                  attempt: taskRun.attempt,
                  itemIndex: taskRun.itemIndex,
                  nodeExecutionId: taskRun.nodeExecutionId,
                  nodeId: taskRun.nodeId,
                  resolvedParents: [],
                  targetNodeConfig: taskRun.targetNodeConfig,
                  taskRunId: taskRun.id,
                  workflowDefinition: plan.workflowDefinition,
                }))
              : null;

        yield* db.insert(schema.taskRuns).values({
          attempt: taskRun.attempt,
          creditCost,
          executionId: taskRun.nodeExecutionId,
          failedAt: committedTaskRun.status === "FAILED" ? new Date() : null,
          failureReason: committedTaskRun.failureReason,
          id: taskRun.id,
          inputSnapshot,
          itemIndex: taskRun.itemIndex,
          jobId: taskRun.id,
          nodeExecutionId: taskRun.nodeExecutionId,
          nodeId: taskRun.nodeId,
          outputIndex: taskRun.itemIndex,
          ownerUserId: nodeExecution.ownerUserId,
          queuedAt: hasDebitedCredits ? new Date() : null,
          runtimeStatus: committedTaskRun.status,
          status: "queued",
          targetReason: "node_run",
          version: taskRun.attempt,
          workflowId: nodeExecution.workflowId,
        });
      }

      for (const dependency of plan.taskDependenciesToCreate) {
        yield* db.insert(schema.taskDependencies).values({
          childTaskRunId: dependency.childTaskRunId,
          id: buildTaskDependencyId(dependency),
          requiredParentItemIndex: dependency.parentItemIndex,
          requiredParentNodeExecutionId: dependency.parentNodeExecutionId,
          requiredParentNodeId: dependency.parentNodeId,
          sourceHandle: dependency.sourceHandle ?? null,
          targetHandle: dependency.targetHandle ?? null,
          targetNodeId: dependency.targetNodeId,
        });
      }

      for (const taskRun of committedTaskRuns) {
        if (taskRun.status !== "QUEUED") {
          continue;
        }
        yield* resolveApprovedDependenciesForChildEffect(taskRun.id);
        const resolvedParents = yield* loadResolvedParentSnapshotsEffect(
          taskRun.id,
        );
        if (!resolvedParents.length) {
          continue;
        }
        yield* db
          .update(schema.taskRuns)
          .set({
            inputSnapshot: buildRepositoryInputSnapshot({
              attempt: taskRun.attempt,
              documentRevision: taskRun.inputSnapshot?.documentRevision,
              itemIndex: taskRun.itemIndex,
              nodeExecutionId: taskRun.nodeExecutionId,
              nodeId: taskRun.nodeId,
              resolvedParents,
              targetNodeConfig: taskRun.targetNodeConfig,
              taskRunId: taskRun.id,
              workflowDefinition: plan.workflowDefinition,
            }),
            updatedAt: new Date(),
          })
          .where(sql`${schema.taskRuns.id} = ${taskRun.id}`);
      }

      const value = buildCommittedPlanResult(
        committedTaskRuns,
        nodeExecutionById,
      );
      return committedOutcome(value, {
        executionJobs: value.executionJobs,
        source: "start-workflow-run",
        taskStatusEvents: value.taskStatusEvents,
        wakeUpJobs: value.wakeUpJobs,
        workflowId: workflowIdFromNodeExecutions(nodeExecutionById),
      });
    }),
  );
}

function loadMissingNodeExecutionIdentitiesEffect(
  plan: WorkflowRunPlan,
  nodeExecutionById: Map<string, NodeExecutionIdentity>,
) {
  const missingNodeExecutionIds = Array.from(
    new Set([
      ...plan.nodeExecutionsToReuse.map((nodeExecution) => nodeExecution.id),
      ...plan.taskRunsToCreate.map((taskRun) => taskRun.nodeExecutionId),
      ...plan.taskDependenciesToCreate.flatMap((dependency) => [
        dependency.childNodeExecutionId,
        dependency.parentNodeExecutionId,
      ]),
    ]),
  ).filter((nodeExecutionId) => !nodeExecutionById.has(nodeExecutionId));

  if (!missingNodeExecutionIds.length) {
    return Effect.void;
  }

  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const rows = yield* db
      .select({
        id: schema.nodeExecutions.id,
        ownerUserId: schema.nodeExecutions.ownerUserId,
        workflowId: schema.nodeExecutions.workflowId,
      })
      .from(schema.nodeExecutions)
      .where(inArray(schema.nodeExecutions.id, missingNodeExecutionIds));

    for (const row of rows) {
      nodeExecutionById.set(row.id, row);
    }
  });
}

function settleTaskRunCompletionEffect(
  command: SettleTaskRunCompletionCommand,
) {
  return repositoryTransaction(
    "settleTaskRunCompletion",
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
        .update(schema.taskRuns)
        .set({
          assetIds: [command.generatedAsset.assetId],
          finishedAt: new Date(),
          runtimeStatus: finalStatus,
          updatedAt: new Date(),
        })
        .where(sql`${schema.taskRuns.id} = ${command.taskRunId}
        and ${schema.taskRuns.ownerUserId} = ${command.ownerUserId}
        and ${schema.taskRuns.attempt} = ${command.attempt}
        and ${schema.taskRuns.runtimeStatus} = 'RUNNING'`)
        .returning({
          attempt: schema.taskRuns.attempt,
          creditCost: schema.taskRuns.creditCost,
          itemIndex: schema.taskRuns.itemIndex,
          nodeExecutionId: schema.taskRuns.nodeExecutionId,
          ownerUserId: schema.taskRuns.ownerUserId,
          runtimeStatus: schema.taskRuns.runtimeStatus,
          taskRunId: schema.taskRuns.id,
          workflowId: schema.taskRuns.workflowId,
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
        taskRunId: row.taskRunId,
        workflowId: row.workflowId,
      });
      yield* adjustTaskRunCostCreditsEffect({
        amount: taskRunCostAdjustmentCredits(
          row.creditCost,
          command.providerCostCredits,
        ),
        ownerUserId: row.ownerUserId,
        taskRunId: row.taskRunId,
        workflowId: row.workflowId,
      });

      const wakeUpJob =
        finalStatus === "APPROVED"
          ? buildWorkflowRuntimeWakeUpJobPayload({
              ownerUserId: row.ownerUserId,
              parentTaskRunId: row.taskRunId,
              workflowId: row.workflowId,
            })
          : null;
      const value = {
        settled: true as const,
        event: buildTaskStatusEvent({
          attempt: requireNumber(row.attempt),
          itemIndex: requireNumber(row.itemIndex),
          nodeExecutionId: row.nodeExecutionId,
          output,
          status: finalStatus,
          taskRunId: row.taskRunId,
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

function settleTaskRunFailureEffect(command: SettleTaskRunFailureCommand) {
  return repositoryTransaction(
    "settleTaskRunFailure",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const failureMessage =
        "message" in command.failureReason
          ? command.failureReason.message
          : null;
      const failureReasonType = command.failureReason.type;
      const [row] = yield* db
        .update(schema.taskRuns)
        .set({
          error: failureMessage,
          failedAt: new Date(),
          failureReason: failureReasonType,
          finishedAt: new Date(),
          runtimeStatus: "FAILED",
          updatedAt: new Date(),
        })
        .where(sql`${schema.taskRuns.id} = ${command.taskRunId}
        and ${schema.taskRuns.ownerUserId} = ${command.ownerUserId}
        and ${schema.taskRuns.attempt} = ${command.attempt}
        and ${schema.taskRuns.runtimeStatus} = 'RUNNING'`)
        .returning({
          attempt: schema.taskRuns.attempt,
          creditCost: schema.taskRuns.creditCost,
          itemIndex: schema.taskRuns.itemIndex,
          nodeExecutionId: schema.taskRuns.nodeExecutionId,
          ownerUserId: schema.taskRuns.ownerUserId,
          taskRunId: schema.taskRuns.id,
          workflowId: schema.taskRuns.workflowId,
        });

      if (!row) {
        return committedOutcome(
          { settled: false as const },
          emptyPostCommitWork("settle-worker-failure", command.workflowId),
        );
      }

      if (command.failureSource.taskRunDebitRefundable) {
        yield* refundTaskRunCreditsEffect({
          amount: row.creditCost,
          ownerUserId: row.ownerUserId,
          taskRunId: row.taskRunId,
          workflowId: row.workflowId,
        });
      }
      yield* adjustTaskRunCostCreditsEffect({
        amount: taskRunCostAdjustmentCredits(
          row.creditCost,
          command.providerCostCredits ?? row.creditCost,
        ),
        ownerUserId: row.ownerUserId,
        taskRunId: row.taskRunId,
        workflowId: row.workflowId,
      });

      const wakeUpJob = buildWorkflowRuntimeWakeUpJobPayload({
        ownerUserId: row.ownerUserId,
        parentTaskRunId: row.taskRunId,
        workflowId: row.workflowId,
      });
      const value = {
        settled: true as const,
        event: buildTaskStatusEvent({
          attempt: requireNumber(row.attempt),
          failureReason: failureReasonType,
          itemIndex: requireNumber(row.itemIndex),
          nodeExecutionId: row.nodeExecutionId,
          status: "FAILED",
          taskRunId: row.taskRunId,
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

function approveTaskRunEffect(
  command: DecideTaskRunReviewCommand & { readonly workflowId: string },
) {
  return repositoryTransaction(
    "approveTaskRun",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const [row] = yield* db
        .update(schema.taskRuns)
        .set({
          finishedAt: new Date(),
          runtimeStatus: "APPROVED",
          updatedAt: new Date(),
        })
        .where(sql`${schema.taskRuns.id} = ${command.taskRunId}
          and ${schema.taskRuns.ownerUserId} = ${command.ownerUserId}
          and ${schema.taskRuns.attempt} = ${command.attempt}
          and ${schema.taskRuns.runtimeStatus} = 'PENDING_REVIEW'`)
        .returning({
          attempt: schema.taskRuns.attempt,
          itemIndex: schema.taskRuns.itemIndex,
          nodeExecutionId: schema.taskRuns.nodeExecutionId,
          ownerUserId: schema.taskRuns.ownerUserId,
          taskRunId: schema.taskRuns.id,
          workflowId: schema.taskRuns.workflowId,
        });
      if (!row) {
        return committedOutcome(
          { decided: false as const },
          emptyPostCommitWork("approve-task-run", command.workflowId),
        );
      }
      const wakeUpJob = buildWorkflowRuntimeWakeUpJobPayload({
        ownerUserId: row.ownerUserId,
        parentTaskRunId: row.taskRunId,
        workflowId: row.workflowId,
      });
      const value = {
        decided: true as const,
        event: buildTaskStatusEvent({
          attempt: requireNumber(row.attempt),
          itemIndex: requireNumber(row.itemIndex),
          nodeExecutionId: row.nodeExecutionId,
          status: "APPROVED",
          taskRunId: row.taskRunId,
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

function cancelTaskRunEffect(
  command: DecideTaskRunReviewCommand & { readonly workflowId: string },
) {
  return repositoryTransaction(
    "cancelTaskRun",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const [current] = yield* db
        .select({ runtimeStatus: schema.taskRuns.runtimeStatus })
        .from(schema.taskRuns)
        .where(sql`${schema.taskRuns.id} = ${command.taskRunId}
          and ${schema.taskRuns.ownerUserId} = ${command.ownerUserId}
          and ${schema.taskRuns.attempt} = ${command.attempt}`)
        .for("update")
        .limit(1);
      const [row] = yield* db
        .update(schema.taskRuns)
        .set({
          finishedAt: new Date(),
          runtimeStatus: "CANCELLED",
          updatedAt: new Date(),
        })
        .where(sql`${schema.taskRuns.id} = ${command.taskRunId}
          and ${schema.taskRuns.ownerUserId} = ${command.ownerUserId}
          and ${schema.taskRuns.attempt} = ${command.attempt}
          and ${schema.taskRuns.runtimeStatus} in ('WAITING_UPSTREAM', 'QUEUED')`)
        .returning({
          attempt: schema.taskRuns.attempt,
          creditCost: schema.taskRuns.creditCost,
          itemIndex: schema.taskRuns.itemIndex,
          nodeExecutionId: schema.taskRuns.nodeExecutionId,
          ownerUserId: schema.taskRuns.ownerUserId,
          taskRunId: schema.taskRuns.id,
          workflowId: schema.taskRuns.workflowId,
        });
      if (!row) {
        const status = yield* loadTaskRunRuntimeStatusEffect(command);
        return committedOutcome(
          blockedCancelResult(status),
          emptyPostCommitWork("cancel-task-run", command.workflowId),
        );
      }
      if (current?.runtimeStatus === "QUEUED") {
        yield* refundTaskRunCreditsEffect({
          amount: row.creditCost,
          ownerUserId: row.ownerUserId,
          taskRunId: row.taskRunId,
          workflowId: row.workflowId,
        });
      }
      const wakeUpJob = buildWorkflowRuntimeWakeUpJobPayload({
        ownerUserId: row.ownerUserId,
        parentTaskRunId: row.taskRunId,
        workflowId: row.workflowId,
      });
      const value = {
        decided: true as const,
        event: buildTaskStatusEvent({
          attempt: requireNumber(row.attempt),
          itemIndex: requireNumber(row.itemIndex),
          nodeExecutionId: row.nodeExecutionId,
          status: "CANCELLED",
          taskRunId: row.taskRunId,
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

function rejectTaskRunAndCreateRegenerationEffect(
  command: RejectTaskRunAndCreateRegenerationCommand & {
    readonly workflowId: string;
  },
) {
  return repositoryTransaction(
    "rejectTaskRunAndCreateRegeneration",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const [rejected] = yield* db
        .update(schema.taskRuns)
        .set({
          finishedAt: new Date(),
          runtimeStatus: "REJECTED",
          updatedAt: new Date(),
        })
        .where(sql`${schema.taskRuns.id} = ${command.taskRunId}
          and ${schema.taskRuns.ownerUserId} = ${command.ownerUserId}
          and ${schema.taskRuns.attempt} = ${command.attempt}
          and ${schema.taskRuns.runtimeStatus} = 'PENDING_REVIEW'`)
        .returning({
          attempt: schema.taskRuns.attempt,
          creditCost: schema.taskRuns.creditCost,
          executionId: schema.taskRuns.executionId,
          inputSnapshot: schema.taskRuns.inputSnapshot,
          itemIndex: schema.taskRuns.itemIndex,
          nodeExecutionId: schema.taskRuns.nodeExecutionId,
          nodeId: schema.taskRuns.nodeId,
          ownerUserId: schema.taskRuns.ownerUserId,
          targetReason: schema.taskRuns.targetReason,
          taskRunId: schema.taskRuns.id,
          workflowId: schema.taskRuns.workflowId,
        });
      if (!rejected) {
        return committedOutcome(
          { rejected: false as const },
          emptyPostCommitWork("reject-task-run", command.workflowId),
        );
      }
      const inputSnapshot = requireTaskRunInputSnapshot(rejected.inputSnapshot);
      const nextAttempt = requireNumber(rejected.attempt) + 1;
      const newSnapshot = buildRepositoryInputSnapshot({
        attempt: nextAttempt,
        itemIndex: requireNumber(rejected.itemIndex),
        nodeExecutionId: rejected.nodeExecutionId,
        nodeId: rejected.nodeId,
        resolvedParents: inputSnapshot.resolvedParentTaskRuns,
        targetNodeConfig: inputSnapshot.targetNodeConfig,
        taskRunId: command.newTaskRunId,
        workflowDefinition: inputSnapshot.workflowDefinition,
      });
      const debit = yield* debitTaskRunCreditsEffect({
        amount: rejected.creditCost,
        ownerUserId: rejected.ownerUserId,
        taskRunId: command.newTaskRunId,
        workflowId: rejected.workflowId,
      });
      const newStatus = debit.debited ? "QUEUED" : "FAILED";
      yield* db.insert(schema.taskRuns).values({
        attempt: nextAttempt,
        creditCost: rejected.creditCost,
        executionId: rejected.executionId,
        failedAt: newStatus === "FAILED" ? new Date() : null,
        failureReason: newStatus === "FAILED" ? "INSUFFICIENT_CREDITS" : null,
        id: command.newTaskRunId,
        inputSnapshot: newStatus === "QUEUED" ? newSnapshot : null,
        itemIndex: requireNumber(rejected.itemIndex),
        jobId: command.newTaskRunId,
        nodeExecutionId: rejected.nodeExecutionId,
        nodeId: rejected.nodeId,
        outputIndex: requireNumber(rejected.itemIndex),
        ownerUserId: rejected.ownerUserId,
        queuedAt: newStatus === "QUEUED" ? new Date() : null,
        runtimeStatus: newStatus,
        status: "queued",
        targetReason: rejected.targetReason,
        version: nextAttempt,
        workflowId: rejected.workflowId,
      });
      const rejectedEvent = buildTaskStatusEvent({
        attempt: requireNumber(rejected.attempt),
        itemIndex: requireNumber(rejected.itemIndex),
        nodeExecutionId: rejected.nodeExecutionId,
        status: "REJECTED",
        taskRunId: rejected.taskRunId,
      });
      const newEvent = buildTaskStatusEvent({
        attempt: nextAttempt,
        ...(newStatus === "FAILED"
          ? { failureReason: "INSUFFICIENT_CREDITS" as const }
          : {}),
        itemIndex: requireNumber(rejected.itemIndex),
        nodeExecutionId: rejected.nodeExecutionId,
        status: newStatus,
        taskRunId: command.newTaskRunId,
      });
      const executionJob =
        newStatus === "QUEUED"
          ? buildWorkflowRuntimeExecutionJobPayload({
              attempt: nextAttempt,
              itemIndex: requireNumber(rejected.itemIndex),
              nodeExecutionId: rejected.nodeExecutionId,
              ownerUserId: rejected.ownerUserId,
              taskRunId: command.newTaskRunId,
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

function wakeUpTaskRunChildrenEffect(
  command: WakeUpTaskRunChildrenRepositoryCommand & {
    readonly workflowId: string;
  },
) {
  return repositoryTransaction(
    "wakeUpTaskRunChildren",
    Effect.gen(function* () {
      const { durableStateChanged, ...value } =
        yield* runWakeUpTaskRunChildrenPersistenceEffect(command);
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
      (cause): WorkflowRuntimeRepositoryFailure => ({
        _tag: "WorkflowRuntimeRepositoryFailure",
        cause,
        operation,
      }),
    ),
  );
}

function buildCommittedPlanResult(
  committedTaskRuns: readonly CommittedPlanTaskRun[],
  nodeExecutionById: ReadonlyMap<string, NodeExecutionIdentity>,
): CommitWorkflowRunPlanResult {
  return {
    executionJobs: committedTaskRuns.flatMap((taskRun) => {
      if (taskRun.status !== "QUEUED") {
        return [];
      }
      const nodeExecution = requireNodeExecutionIdentity(
        nodeExecutionById,
        taskRun.nodeExecutionId,
      );
      return buildWorkflowRuntimeExecutionJobPayload({
        attempt: taskRun.attempt,
        itemIndex: taskRun.itemIndex,
        nodeExecutionId: taskRun.nodeExecutionId,
        ownerUserId: nodeExecution.ownerUserId,
        taskRunId: taskRun.id,
        workflowId: nodeExecution.workflowId,
      });
    }),
    taskStatusEvents: committedTaskRuns.map((taskRun) =>
      buildTaskStatusEvent({
        attempt: taskRun.attempt,
        ...(taskRun.failureReason
          ? { failureReason: taskRun.failureReason }
          : {}),
        itemIndex: taskRun.itemIndex,
        nodeExecutionId: taskRun.nodeExecutionId,
        status: taskRun.status,
        taskRunId: taskRun.id,
      }),
    ),
    wakeUpJobs: committedTaskRuns.flatMap((taskRun) => {
      if (taskRun.status !== "FAILED") {
        return [];
      }
      const nodeExecution = requireNodeExecutionIdentity(
        nodeExecutionById,
        taskRun.nodeExecutionId,
      );
      return buildWorkflowRuntimeWakeUpJobPayload({
        ownerUserId: nodeExecution.ownerUserId,
        parentTaskRunId: taskRun.id,
        workflowId: nodeExecution.workflowId,
      });
    }),
  };
}

function debitTaskRunCreditsEffect(command: {
  readonly amount: number;
  readonly ownerUserId: string;
  readonly taskRunId: string;
  readonly workflowId: string;
}) {
  return Effect.gen(function* () {
    if (command.amount <= 0) {
      return { debited: true as const };
    }
    const db = yield* PgDrizzle.PgDrizzle;
    const balance = yield* lockUserAndReadBalanceEffect(command.ownerUserId);
    const sourceKey = buildTaskRunCreditLedgerSourceKey({
      operation: "debit",
      taskRunId: command.taskRunId,
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
      reason: "task_run_debit",
      sourceKey,
      userId: command.ownerUserId,
    });
    return { debited: true as const };
  });
}

function refundTaskRunCreditsEffect(command: {
  readonly amount: number;
  readonly ownerUserId: string;
  readonly taskRunId: string;
  readonly workflowId: string;
}) {
  return Effect.gen(function* () {
    if (command.amount <= 0) {
      return;
    }
    const db = yield* PgDrizzle.PgDrizzle;
    const sourceKey = buildTaskRunCreditLedgerSourceKey({
      operation: "refund",
      taskRunId: command.taskRunId,
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
      reason: "task_run_refund",
      sourceKey,
      userId: command.ownerUserId,
    });
  });
}

function adjustTaskRunCostCreditsEffect(command: {
  readonly amount: number;
  readonly ownerUserId: string;
  readonly taskRunId: string;
  readonly workflowId: string;
}) {
  return Effect.gen(function* () {
    if (command.amount <= 0) {
      return { adjusted: false as const, amount: 0 as const };
    }
    const db = yield* PgDrizzle.PgDrizzle;
    const sourceKey = buildTaskRunCreditLedgerSourceKey({
      operation: "cost_adjustment",
      taskRunId: command.taskRunId,
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
      reason: "task_run_cost_adjustment",
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
  readonly asset: WorkflowRuntimeGeneratedPrimaryAssetPayload;
  readonly ownerUserId: string;
  readonly taskRunId: string;
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
      taskRunId: input.taskRunId,
      textContent: "text" in asset ? asset.text : null,
      workflowId: input.workflowId,
    });
  });
}

function runWakeUpTaskRunChildrenPersistenceEffect(
  command: WakeUpTaskRunChildrenRepositoryCommand & {
    readonly workflowId: string;
  },
) {
  return Effect.gen(function* () {
    if (!(yield* wakeUpParentExistsEffect(command))) {
      return { executionJobs: [], parentFound: false, taskStatusEvents: [] };
    }
    const initialState = yield* loadWakeUpGatekeeperStateEffect(command);

    const gatekeeperResult = wakeUpTaskRunChildren(initialState, {
      settledParentTaskRunId: command.settledParentTaskRunId,
    });
    const debitAdjustedResult = yield* applyWakeUpTaskRunDebitsEffect(
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
        debitAdjustedResult.executionJobs.map((job) => job.taskRunId),
      ),
      parentFound: true,
      taskStatusEvents: debitAdjustedResult.taskStatusEvents,
    };
  });
}

function wakeUpParentExistsEffect(
  command: WakeUpTaskRunChildrenRepositoryCommand & {
    readonly workflowId: string;
  },
) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const rows = yield* db
      .select({ id: schema.taskRuns.id })
      .from(schema.taskRuns)
      .where(sql`${schema.taskRuns.id} = ${command.settledParentTaskRunId}
        and ${schema.taskRuns.ownerUserId} = ${command.ownerUserId}
        and ${schema.taskRuns.workflowId} = ${command.workflowId}
        and ${schema.taskRuns.runtimeStatus} is not null`)
      .limit(1);
    return rows.length > 0;
  });
}

function loadWakeUpGatekeeperStateEffect(
  command: WakeUpTaskRunChildrenRepositoryCommand & {
    readonly workflowId: string;
  },
) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const balance = yield* lockUserAndReadBalanceEffect(command.ownerUserId);
    const taskRunRows = yield* db
      .select({
        attempt: schema.taskRuns.attempt,
        creditCost: schema.taskRuns.creditCost,
        failureReason: schema.taskRuns.failureReason,
        inputSnapshot: schema.taskRuns.inputSnapshot,
        itemIndex: schema.taskRuns.itemIndex,
        nodeId: schema.taskRuns.nodeId,
        nodeExecutionId: schema.taskRuns.nodeExecutionId,
        runtimeStatus: schema.taskRuns.runtimeStatus,
        taskRunId: schema.taskRuns.id,
      })
      .from(schema.taskRuns)
      .where(sql`${schema.taskRuns.ownerUserId} = ${command.ownerUserId}
        and ${schema.taskRuns.workflowId} = ${command.workflowId}
        and ${schema.taskRuns.runtimeStatus} is not null`)
      .orderBy(
        schema.taskRuns.nodeExecutionId,
        schema.taskRuns.itemIndex,
        schema.taskRuns.attempt,
        schema.taskRuns.id,
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
        taskRunId: schema.assets.taskRunId,
      })
      .from(schema.assets)
      .innerJoin(
        schema.taskRuns,
        sql`${schema.taskRuns.id} = ${schema.assets.taskRunId}`,
      )
      .where(sql`${schema.taskRuns.ownerUserId} = ${command.ownerUserId}
        and ${schema.taskRuns.workflowId} = ${command.workflowId}`)
      .orderBy(schema.assets.id);
    const assetsByTaskRunId = new Map(
      assetRows.map((row) => [row.taskRunId, row]),
    );
    const taskRunsById = new Map<string, TaskRunGatekeeperTaskRun>();
    for (const row of taskRunRows) {
      if (taskRunsById.has(row.taskRunId)) {
        continue;
      }
      const assetRow = assetsByTaskRunId.get(row.taskRunId);
      const asset = assetRow ? buildWorkflowAssetFromRow(assetRow) : null;
      const output = assetRow ? buildRenderableOutputFromRow(assetRow) : null;
      taskRunsById.set(row.taskRunId, {
        attempt: requireNumber(row.attempt),
        creditCost: requireNumber(row.creditCost),
        ...(asset ? { asset } : {}),
        ...(row.failureReason
          ? {
              failureReason: taskRunFailureReasonFromDatabase(
                row.failureReason,
              ),
            }
          : {}),
        id: row.taskRunId,
        inputSnapshot:
          optionalTaskRunInputSnapshot(row.inputSnapshot) ?? undefined,
        itemIndex: requireNumber(row.itemIndex),
        nodeExecutionId: row.nodeExecutionId,
        nodeId: row.nodeId,
        ...(output ? { output } : {}),
        status: requireTaskRunRuntimeStatus(row.runtimeStatus),
      });
    }

    const dependencies = yield* db
      .select({
        childTaskRunId: schema.taskDependencies.childTaskRunId,
        requiredParentItemIndex:
          schema.taskDependencies.requiredParentItemIndex,
        requiredParentNodeExecutionId:
          schema.taskDependencies.requiredParentNodeExecutionId,
        requiredParentNodeId: schema.taskDependencies.requiredParentNodeId,
        resolvedParentTaskRunId:
          schema.taskDependencies.resolvedParentTaskRunId,
        sourceHandle: schema.taskDependencies.sourceHandle,
        targetHandle: schema.taskDependencies.targetHandle,
        targetNodeId: schema.taskDependencies.targetNodeId,
      })
      .from(schema.taskDependencies)
      .innerJoin(
        schema.taskRuns,
        sql`${schema.taskRuns.id} = ${schema.taskDependencies.childTaskRunId}`,
      )
      .where(sql`${schema.taskRuns.ownerUserId} = ${command.ownerUserId}
        and ${schema.taskRuns.workflowId} = ${command.workflowId}
        and ${schema.taskRuns.runtimeStatus} is not null`)
      .orderBy(schema.taskDependencies.id);

    return {
      creditBalance: balance,
      dependencies: dependencies.map((dependency) => ({
        childTaskRunId: dependency.childTaskRunId,
        requiredParentItemIndex: requireNumber(
          dependency.requiredParentItemIndex,
        ),
        requiredParentNodeExecutionId: dependency.requiredParentNodeExecutionId,
        requiredParentNodeId: dependency.requiredParentNodeId,
        resolvedParentTaskRunId: dependency.resolvedParentTaskRunId,
        sourceHandle: dependency.sourceHandle,
        targetHandle: dependency.targetHandle,
        targetNodeId: dependency.targetNodeId,
      })),
      taskRuns: Array.from(taskRunsById.values()),
    } satisfies TaskRunGatekeeperState;
  });
}

function applyWakeUpTaskRunDebitsEffect(
  command: WakeUpTaskRunChildrenRepositoryCommand & {
    readonly workflowId: string;
  },
  gatekeeperResult: ReturnType<typeof wakeUpTaskRunChildren>,
) {
  return Effect.gen(function* () {
    let nextResult = gatekeeperResult;
    const failedDebitTaskRunIds = new Set<string>();
    for (const job of gatekeeperResult.executionJobs) {
      const taskRun = requireGatekeeperTaskRun(nextResult.state, job.taskRunId);
      const debit = yield* debitTaskRunCreditsEffect({
        amount: taskRun.creditCost,
        ownerUserId: command.ownerUserId,
        taskRunId: taskRun.id,
        workflowId: command.workflowId,
      });
      if (debit.debited) {
        continue;
      }
      failedDebitTaskRunIds.add(taskRun.id);
      const failureResult = recordDirectTaskRunFailure(nextResult.state, {
        failureReason: { type: "INSUFFICIENT_CREDITS" },
        taskRunId: taskRun.id,
      });
      nextResult = {
        executionJobs: nextResult.executionJobs.filter(
          (candidate) => candidate.taskRunId !== taskRun.id,
        ),
        state: failureResult.state,
        taskStatusEvents: [
          ...nextResult.taskStatusEvents.filter(
            (event) => !failedDebitTaskRunIds.has(event.taskRunId),
          ),
          ...failureResult.taskStatusEvents,
        ],
      };
    }
    return nextResult;
  });
}

function persistWakeUpGatekeeperResultEffect(
  initialState: TaskRunGatekeeperState,
  nextState: TaskRunGatekeeperState,
) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const initialTaskRuns = new Map(
      initialState.taskRuns.map((taskRun) => [taskRun.id, taskRun]),
    );
    let durableStateChanged = false;

    for (const dependency of nextState.dependencies) {
      const initialDependency = initialState.dependencies.find(
        (candidate) =>
          candidate.childTaskRunId === dependency.childTaskRunId &&
          candidate.requiredParentNodeExecutionId ===
            dependency.requiredParentNodeExecutionId &&
          candidate.requiredParentItemIndex ===
            dependency.requiredParentItemIndex &&
          candidate.sourceHandle === dependency.sourceHandle &&
          candidate.targetHandle === dependency.targetHandle,
      );
      if (
        !initialDependency ||
        initialDependency.resolvedParentTaskRunId ===
          dependency.resolvedParentTaskRunId
      ) {
        continue;
      }
      const [updated] = yield* db
        .update(schema.taskDependencies)
        .set({
          resolvedAt: new Date(),
          resolvedParentTaskRunId: dependency.resolvedParentTaskRunId,
        })
        .where(sql`${schema.taskDependencies.childTaskRunId} = ${dependency.childTaskRunId}
          and ${schema.taskDependencies.requiredParentNodeExecutionId} = ${dependency.requiredParentNodeExecutionId}
          and ${schema.taskDependencies.requiredParentItemIndex} = ${dependency.requiredParentItemIndex}
          and ${schema.taskDependencies.sourceHandle} is not distinct from ${dependency.sourceHandle}
          and ${schema.taskDependencies.targetHandle} is not distinct from ${dependency.targetHandle}
          and ${schema.taskDependencies.resolvedParentTaskRunId} is null`)
        .returning({ id: schema.taskDependencies.id });
      durableStateChanged = durableStateChanged || Boolean(updated);
    }

    for (const taskRun of nextState.taskRuns) {
      const initialTaskRun = initialTaskRuns.get(taskRun.id);
      if (
        !initialTaskRun ||
        !gatekeeperTaskRunChanged(initialTaskRun, taskRun)
      ) {
        continue;
      }
      const [updated] = yield* db
        .update(schema.taskRuns)
        .set({
          error:
            taskRun.status === "UPSTREAM_FAILED"
              ? `Upstream Task Run ${taskRun.failureReason?.type === "UPSTREAM_FAILED" ? taskRun.failureReason.failedParentTaskRunId : "unknown"} did not approve.`
              : null,
          failedAt:
            taskRun.status === "FAILED" || taskRun.status === "UPSTREAM_FAILED"
              ? new Date()
              : null,
          failureReason: taskRun.failureReason?.type ?? null,
          inputSnapshot: taskRun.inputSnapshot ?? null,
          queuedAt: taskRun.status === "QUEUED" ? new Date() : null,
          runtimeStatus: taskRun.status,
          updatedAt: new Date(),
        })
        .where(sql`${schema.taskRuns.id} = ${taskRun.id}
          and ${schema.taskRuns.runtimeStatus} = ${initialTaskRun.status}`)
        .returning({ id: schema.taskRuns.id });
      durableStateChanged = durableStateChanged || Boolean(updated);
    }

    return durableStateChanged;
  });
}

function buildWakeUpExecutionJobs(
  command: WakeUpTaskRunChildrenRepositoryCommand & {
    readonly workflowId: string;
  },
  state: TaskRunGatekeeperState,
  taskRunIds: readonly string[],
): readonly WorkflowRuntimeExecutionJobPayload[] {
  return taskRunIds.map((taskRunId) => {
    const taskRun = requireGatekeeperTaskRun(state, taskRunId);
    return buildWorkflowRuntimeExecutionJobPayload({
      attempt: taskRun.attempt,
      itemIndex: taskRun.itemIndex,
      nodeExecutionId: taskRun.nodeExecutionId,
      ownerUserId: command.ownerUserId,
      taskRunId: taskRun.id,
      workflowId: command.workflowId,
    });
  });
}

function requireGatekeeperTaskRun(
  state: TaskRunGatekeeperState,
  taskRunId: string,
): TaskRunGatekeeperTaskRun {
  const taskRun = state.taskRuns.find(
    (candidate) => candidate.id === taskRunId,
  );
  if (!taskRun) {
    throw new TypeError(`Missing gatekeeper Task Run ${taskRunId}`);
  }
  return taskRun;
}

function gatekeeperTaskRunChanged(
  left: TaskRunGatekeeperTaskRun,
  right: TaskRunGatekeeperTaskRun,
): boolean {
  return (
    left.status !== right.status ||
    JSON.stringify(left.failureReason ?? null) !==
      JSON.stringify(right.failureReason ?? null) ||
    JSON.stringify(left.inputSnapshot ?? null) !==
      JSON.stringify(right.inputSnapshot ?? null)
  );
}

function taskRunFailureReasonFromDatabase(value: string): TaskRunFailureReason {
  if (value === "UPSTREAM_FAILED") {
    return { failedParentTaskRunId: "unknown", type: "UPSTREAM_FAILED" };
  }
  if (value === "INSUFFICIENT_CREDITS") {
    return { type: "INSUFFICIENT_CREDITS" };
  }
  if (value === "PROVIDER_FAILED") {
    return { message: "Provider failed.", type: "PROVIDER_FAILED" };
  }
  return { message: "Execution failed.", type: "EXECUTION_FAILED" };
}

function resolveApprovedDependenciesForChildEffect(childTaskRunId: string) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const dependencies = yield* db
      .select({
        id: schema.taskDependencies.id,
        parentItemIndex: schema.taskDependencies.requiredParentItemIndex,
        parentNodeExecutionId:
          schema.taskDependencies.requiredParentNodeExecutionId,
      })
      .from(schema.taskDependencies)
      .where(sql`${schema.taskDependencies.childTaskRunId} = ${childTaskRunId}
        and ${schema.taskDependencies.resolvedParentTaskRunId} is null`)
      .orderBy(schema.taskDependencies.id);
    for (const dependency of dependencies) {
      const [parent] = yield* db
        .select({ id: schema.taskRuns.id })
        .from(schema.taskRuns)
        .where(sql`${schema.taskRuns.nodeExecutionId} = ${dependency.parentNodeExecutionId}
          and ${schema.taskRuns.itemIndex} = ${dependency.parentItemIndex}
          and ${schema.taskRuns.runtimeStatus} = 'APPROVED'`)
        .orderBy(sql`${schema.taskRuns.attempt} desc`, schema.taskRuns.id)
        .limit(1);
      if (!parent) {
        continue;
      }
      yield* db
        .update(schema.taskDependencies)
        .set({
          resolvedAt: new Date(),
          resolvedParentTaskRunId: parent.id,
        })
        .where(sql`${schema.taskDependencies.id} = ${dependency.id}`);
    }
  });
}

function loadResolvedParentSnapshotsEffect(childTaskRunId: string) {
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
        attempt: schema.taskRuns.attempt,
        itemIndex: schema.taskRuns.itemIndex,
        nodeExecutionId: schema.taskRuns.nodeExecutionId,
        parentItemIndex: schema.taskDependencies.requiredParentItemIndex,
        parentNodeId: schema.taskDependencies.requiredParentNodeId,
        sourceHandle: schema.taskDependencies.sourceHandle,
        targetHandle: schema.taskDependencies.targetHandle,
        targetNodeId: schema.taskDependencies.targetNodeId,
        taskRunId: schema.taskRuns.id,
      })
      .from(schema.taskDependencies)
      .innerJoin(
        schema.taskRuns,
        sql`${schema.taskRuns.id} = ${schema.taskDependencies.resolvedParentTaskRunId}`,
      )
      .leftJoin(
        schema.assets,
        sql`${schema.assets.taskRunId} = ${schema.taskRuns.id}`,
      )
      .where(sql`${schema.taskDependencies.childTaskRunId} = ${childTaskRunId}`)
      .orderBy(schema.taskDependencies.id, schema.assets.id);
    return rows.map((row) => {
      const asset = buildWorkflowAssetFromRow(row);
      const output = buildRenderableOutputFromRow(row);
      return {
        ...(asset ? { asset } : {}),
        address: {
          parentItemIndex: requireNumber(row.parentItemIndex),
          parentNodeId: row.parentNodeId,
          sourceHandle: row.sourceHandle,
          targetHandle: row.targetHandle,
          targetNodeId: row.targetNodeId,
        },
        attempt: requireNumber(row.attempt),
        itemIndex: requireNumber(row.itemIndex),
        nodeExecutionId: row.nodeExecutionId,
        ...(output ? { output } : {}),
        taskRunId: row.taskRunId,
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

function loadTaskRunRuntimeStatusEffect(command: DecideTaskRunReviewCommand) {
  return Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const rows = yield* db
      .select({ runtimeStatus: schema.taskRuns.runtimeStatus })
      .from(schema.taskRuns)
      .where(sql`${schema.taskRuns.id} = ${command.taskRunId}
        and ${schema.taskRuns.ownerUserId} = ${command.ownerUserId}
        and ${schema.taskRuns.attempt} = ${command.attempt}`)
      .for("update")
      .limit(1);
    return rows[0]?.runtimeStatus ?? null;
  });
}

function getRuntimeTaskRunsForNodeExecutionEffect(command: {
  readonly nodeExecutionId: string;
  readonly ownerUserId: string;
}) {
  return repositoryTransaction(
    "getRuntimeTaskRunsForNodeExecution",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const rows = yield* db
        .select({
          attempt: schema.taskRuns.attempt,
          inputSnapshot: schema.taskRuns.inputSnapshot,
          itemIndex: schema.taskRuns.itemIndex,
          nodeExecutionId: schema.taskRuns.nodeExecutionId,
          ownerUserId: schema.taskRuns.ownerUserId,
          runtimeStatus: schema.taskRuns.runtimeStatus,
          taskRunId: schema.taskRuns.id,
          workflowId: schema.taskRuns.workflowId,
        })
        .from(schema.taskRuns)
        .where(sql`${schema.taskRuns.nodeExecutionId} = ${command.nodeExecutionId}
          and ${schema.taskRuns.ownerUserId} = ${command.ownerUserId}
          and ${schema.taskRuns.runtimeStatus} is not null`)
        .orderBy(
          schema.taskRuns.itemIndex,
          schema.taskRuns.attempt,
          schema.taskRuns.id,
        );
      return rows.map((row) => ({
        attempt: requireNumber(row.attempt),
        inputSnapshot: optionalTaskRunInputSnapshot(row.inputSnapshot) ?? null,
        itemIndex: requireNumber(row.itemIndex),
        nodeExecutionId: row.nodeExecutionId,
        ownerUserId: row.ownerUserId,
        runtimeStatus: requireTaskRunRuntimeStatus(row.runtimeStatus),
        taskRunId: row.taskRunId,
        workflowId: row.workflowId,
      }));
    }),
  );
}

function getTaskDependenciesForChildEffect(command: {
  readonly childTaskRunId: string;
}) {
  return repositoryTransaction(
    "getTaskDependenciesForChild",
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle;
      const rows = yield* db
        .select({
          childTaskRunId: schema.taskDependencies.childTaskRunId,
          requiredParentItemIndex:
            schema.taskDependencies.requiredParentItemIndex,
          requiredParentNodeExecutionId:
            schema.taskDependencies.requiredParentNodeExecutionId,
          requiredParentNodeId: schema.taskDependencies.requiredParentNodeId,
          resolvedParentTaskRunId:
            schema.taskDependencies.resolvedParentTaskRunId,
          sourceHandle: schema.taskDependencies.sourceHandle,
          targetHandle: schema.taskDependencies.targetHandle,
          targetNodeId: schema.taskDependencies.targetNodeId,
        })
        .from(schema.taskDependencies)
        .where(
          sql`${schema.taskDependencies.childTaskRunId} = ${command.childTaskRunId}`,
        )
        .orderBy(
          schema.taskDependencies.requiredParentNodeExecutionId,
          schema.taskDependencies.requiredParentItemIndex,
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

function countPlannedTaskRunsForNodeExecution(
  plan: WorkflowRunPlan,
  nodeExecutionId: string,
) {
  return plan.taskRunsToCreate.filter(
    (taskRun) => taskRun.nodeExecutionId === nodeExecutionId,
  ).length;
}

function staleTaskRunTransition(
  command: { readonly attempt: number; readonly taskRunId: string },
  operation: string,
) {
  return Effect.fail({
    _tag: "StaleTaskRunTransition",
    attempt: command.attempt,
    operation,
    taskRunId: command.taskRunId,
  } satisfies StaleTaskRunTransition);
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

function workflowIdFromNodeExecutions(
  nodeExecutionById: ReadonlyMap<string, NodeExecutionIdentity>,
): string {
  const workflowId = nodeExecutionById.values().next().value?.workflowId;
  if (!workflowId) {
    throw new TypeError(
      "Workflow Run plan has no transaction-local workflow id",
    );
  }

  return workflowId;
}

function buildRepositoryInputSnapshot(input: {
  readonly attempt: number;
  readonly documentRevision?: number | null;
  readonly itemIndex: number;
  readonly nodeExecutionId: string;
  readonly nodeId: string;
  readonly resolvedParents: readonly ResolvedParentTaskRunSnapshot[] | null;
  readonly targetNodeConfig: TaskRunInputSnapshot["targetNodeConfig"];
  readonly taskRunId: string;
  readonly workflowDefinition: TaskRunInputSnapshot["workflowDefinition"];
}): TaskRunInputSnapshot {
  return buildTaskRunInputSnapshot({
    attempt: input.attempt,
    documentRevision: input.documentRevision,
    itemIndex: input.itemIndex,
    nodeExecutionId: input.nodeExecutionId,
    nodeId: input.nodeId,
    resolvedParentTaskRuns: input.resolvedParents ?? [],
    targetNodeConfig: input.targetNodeConfig,
    taskRunId: input.taskRunId,
    workflowDefinition: input.workflowDefinition,
  });
}

function requireNodeExecutionIdentity(
  nodeExecutionById: ReadonlyMap<string, NodeExecutionIdentity>,
  nodeExecutionId: string,
) {
  const nodeExecution = nodeExecutionById.get(nodeExecutionId);
  if (!nodeExecution) {
    throw new TypeError(`Missing Node Execution ${nodeExecutionId}`);
  }

  return nodeExecution;
}

function buildTaskDependencyId(input: {
  readonly childTaskRunId: string;
  readonly parentNodeExecutionId: string;
  readonly parentItemIndex: number;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
}) {
  return [
    input.childTaskRunId,
    input.parentNodeExecutionId,
    input.parentItemIndex,
    input.sourceHandle ?? "",
    input.targetHandle ?? "",
  ].join(":");
}

function taskRunCostAdjustmentCredits(
  creditCost: number,
  providerCostCredits: number,
): number {
  return Math.ceil(Math.max(providerCostCredits - creditCost, 0));
}

function blockedCancelResult(status: string | null): CancelTaskRunResult {
  if (status === "RUNNING") {
    return {
      blocked: true,
      decided: false,
      message: "Running Task Runs cannot be cancelled.",
      reason: "RUNNING_TASK_RUN_CANCELLATION_BLOCKED",
    };
  }

  if (status === "PENDING_REVIEW") {
    return {
      blocked: true,
      decided: false,
      message:
        "Pending Review Task Runs must be approved or rejected instead of cancelled.",
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

function requireTaskRunRuntimeStatus(
  value: unknown,
): RuntimeTaskRunRow["runtimeStatus"] {
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

  throw new TypeError("Expected task run runtime status value");
}

function requireTaskRunInputSnapshot(value: unknown): TaskRunInputSnapshot {
  if (!isTaskRunInputSnapshot(value)) {
    throw new TypeError("Expected task run input snapshot database value");
  }

  return value;
}

function requireExecutableTaskRunInputSnapshot(
  value: unknown,
): ExecutableTaskRunInputSnapshot {
  const snapshot = requireTaskRunInputSnapshot(value);
  if (snapshot.providerInput.kind === "non-executable-node") {
    throw new TypeError(
      "Expected executable task run input snapshot database value",
    );
  }

  return { ...snapshot, providerInput: snapshot.providerInput };
}

function optionalTaskRunInputSnapshot(
  value: unknown,
): TaskRunInputSnapshot | null {
  return value === null ? null : requireTaskRunInputSnapshot(value);
}
