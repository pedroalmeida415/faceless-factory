import { type SQL, sql } from "drizzle-orm";
import {
  type GeneratedAsset,
  projectGeneratedAssetToTaskOutput,
} from "~/lib/workflow-runtime/assets/generated-asset-projection";
import type { TaskRunFailureReason } from "~/lib/workflow-runtime/domain/task-run-state";
import {
  buildTaskRunInputSnapshot,
  type ExecutableTaskRunInputSnapshot,
  isTaskRunInputSnapshot,
  type TaskRunInputSnapshot,
} from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
import type { WorkflowRunPlan } from "~/lib/workflow-runtime/planning/workflow-run-planner";
import {
  buildTaskStatusEvent,
  type TaskStatusEvent,
} from "~/lib/workflow-runtime/runtime/task-status-events";
import {
  type WakeUpTaskRunChildrenRepositoryCommand,
  type WakeUpTaskRunChildrenRepositoryResult,
  wakeUpTaskRunChildrenInRepository,
} from "~/server/workflow-runtime/workflow-runtime-gatekeeper-repository";
import {
  buildWorkflowRuntimeExecutionJobPayload,
  buildWorkflowRuntimeWakeUpJobPayload,
  type WorkflowRuntimeExecutionJobPayload,
  type WorkflowRuntimeWakeUpJobPayload,
} from "~/server/workflow-runtime/workflow-runtime-queue";

type DbExecutor = {
  readonly execute: (query: SQL) => Promise<unknown>;
};

type DbLike = DbExecutor & {
  readonly transaction: <T>(
    callback: (tx: DbExecutor) => Promise<T>,
  ) => Promise<T>;
};

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

type GeneratedPrimaryAssetInput = GeneratedAsset & {
  readonly contentType: string;
  readonly externalUri?: string | null;
  readonly fileName: string;
  readonly model?: string | null;
  readonly sizeBytes: number;
  readonly storageKey?: string | null;
  readonly storageProvider: string;
};

type SettleTaskRunCompletionCommand = {
  readonly attempt: number;
  readonly finalCostCredits: number;
  readonly generatedAsset: GeneratedPrimaryAssetInput;
  readonly ownerUserId: string;
  readonly reviewRequired: boolean;
  readonly taskRunId: string;
};

type SettleTaskRunFailureCommand = {
  readonly attempt: number;
  readonly failureReason: Exclude<
    TaskRunFailureReason,
    { readonly type: "UPSTREAM_FAILED" }
  >;
  readonly finalCostCredits?: number;
  readonly ownerUserId: string;
  readonly taskRunId: string;
};

type DecideTaskRunReviewCommand = {
  readonly attempt: number;
  readonly ownerUserId: string;
  readonly taskRunId: string;
};

type RejectTaskRunAndCreateRegenerationCommand = DecideTaskRunReviewCommand & {
  readonly newTaskRunId: string;
};

type SettleTaskRunCompletionResult =
  | {
      readonly settled: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload | null;
    }
  | { readonly settled: false };

type SettleTaskRunFailureResult =
  | {
      readonly settled: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload;
    }
  | { readonly settled: false };

type DecideTaskRunReviewResult =
  | {
      readonly decided: true;
      readonly event: TaskStatusEvent;
      readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload;
    }
  | { readonly decided: false };

type RejectTaskRunAndCreateRegenerationResult =
  | {
      readonly rejected: true;
      readonly executionJob: WorkflowRuntimeExecutionJobPayload | null;
      readonly taskStatusEvents: readonly TaskStatusEvent[];
    }
  | { readonly rejected: false };

type CreditLedgerEntrySnapshot = {
  readonly amount: number;
  readonly balanceAfter: number;
  readonly kind: string;
  readonly sourceKey: string;
};

type ListQueuedTaskRunJobsCommand = {
  readonly limit: number;
};

type CommitWorkflowRunPlanResult = {
  readonly executionJobs: readonly WorkflowRuntimeExecutionJobPayload[];
  readonly taskStatusEvents: readonly TaskStatusEvent[];
  readonly wakeUpJobs: readonly WorkflowRuntimeWakeUpJobPayload[];
};

type CommittedPlanTaskRun = Omit<
  WorkflowRunPlan["taskRunsToCreate"][number],
  "status"
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
  readonly reservedCredits: number | null;
  readonly runtimeStatus: string;
  readonly taskRunId: string;
  readonly workflowId: string;
};

type TaskDependencyRow = {
  readonly childTaskRunId: string;
  readonly requiredParentItemIndex: number;
  readonly requiredParentNodeId?: string | null;
  readonly requiredParentNodeExecutionId: string;
  readonly resolvedParentTaskRunId: string | null;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
  readonly targetNodeId?: string | null;
};

type RejectedTaskRunRow = {
  readonly attempt: number;
  readonly estimatedCreditCost: number;
  readonly executionId: string;
  readonly itemIndex: number;
  readonly nodeExecutionId: string;
  readonly nodeId: string;
  readonly ownerUserId: string;
  readonly targetReason: string;
  readonly targetNodeConfig: TaskRunInputSnapshot["targetNodeConfig"];
  readonly taskRunId: string;
  readonly workflowId: string;
};

type ResolvedParentTaskRunSnapshot =
  TaskRunInputSnapshot["resolvedParentTaskRuns"][number];

type QueuedTaskRunFreeze = {
  readonly inputSnapshot: TaskRunInputSnapshot;
  readonly resolvedParentTaskRunByDependencyId: ReadonlyMap<string, string>;
};

type NodeExecutionIdentity = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly workflowId: string;
};

type QueryRow = Record<string, unknown>;

export function createWorkflowRuntimeRepository(db: DbLike) {
  return {
    async commitWorkflowRunPlan(
      plan: WorkflowRunPlan,
    ): Promise<CommitWorkflowRunPlanResult> {
      return db.transaction(async (tx) => {
        const nodeExecutionById = new Map<string, NodeExecutionIdentity>();

        for (const nodeExecution of plan.nodeExecutionsToCreate) {
          nodeExecutionById.set(nodeExecution.id, {
            id: nodeExecution.id,
            ownerUserId: nodeExecution.ownerId,
            workflowId: nodeExecution.workflowId,
          });
          await tx.execute(sql`
            insert into node_executions (
              id,
              workflow_id,
              owner_user_id,
              node_id,
              execution_id,
              document_revision,
              status,
              output_count,
              target_reason,
              created_at,
              updated_at
            ) values (
              ${nodeExecution.id},
              ${nodeExecution.workflowId},
              ${nodeExecution.ownerId},
              ${nodeExecution.nodeId},
              ${nodeExecution.id},
              null,
              'pending',
              ${countPlannedTaskRunsForNodeExecution(plan, nodeExecution.id)},
              'node_run',
              now(),
              now()
            )
          `);
        }

        for (const nodeExecutionId of nodeExecutionIdsRequiredByTaskRuns(
          plan,
        )) {
          if (!nodeExecutionById.has(nodeExecutionId)) {
            nodeExecutionById.set(
              nodeExecutionId,
              await loadNodeExecutionIdentity(tx, nodeExecutionId),
            );
          }
        }

        const queuedTaskRunFreezes = await buildQueuedTaskRunFreezes(tx, plan);
        const committedTaskRuns: CommittedPlanTaskRun[] = [];

        for (const taskRun of plan.taskRunsToCreate) {
          const nodeExecution = requireNodeExecutionIdentity(
            nodeExecutionById,
            taskRun.nodeExecutionId,
          );
          const freeze = queuedTaskRunFreezes.get(taskRun.id);
          const estimatedCreditCost = taskRun.estimatedCreditCost ?? 0;
          const renderingFailureReason =
            renderingFailureReasonFromFreeze(freeze);
          const hasReservedCredits =
            taskRun.status === "QUEUED" && !renderingFailureReason
              ? await reserveInitialQueuedTaskRunCredits(tx, {
                  amount: estimatedCreditCost,
                  ownerUserId: nodeExecution.ownerUserId,
                  taskRunId: taskRun.id,
                  workflowId: nodeExecution.workflowId,
                })
              : false;
          const committedTaskRun: CommittedPlanTaskRun = renderingFailureReason
            ? {
                ...taskRun,
                failureReason: renderingFailureReason,
                status: "FAILED",
              }
            : taskRun.status !== "QUEUED" || hasReservedCredits
              ? taskRun
              : {
                  ...taskRun,
                  failureReason: "INSUFFICIENT_CREDITS",
                  status: "FAILED",
                };
          committedTaskRuns.push(committedTaskRun);
          const inputSnapshot =
            committedTaskRun.status === "QUEUED" && hasReservedCredits
              ? (freeze?.inputSnapshot ?? null)
              : committedTaskRun.status === "WAITING_UPSTREAM"
                ? buildRepositoryInputSnapshot({
                    attempt: taskRun.attempt,
                    itemIndex: taskRun.itemIndex,
                    nodeExecutionId: taskRun.nodeExecutionId,
                    nodeId: taskRun.nodeId,
                    resolvedParents: [],
                    targetNodeConfig: taskRun.targetNodeConfig,
                    taskRunId: taskRun.id,
                  })
                : null;

          await tx.execute(sql`
            insert into task_runs (
              id,
              node_execution_id,
              workflow_id,
              owner_user_id,
              node_id,
              output_index,
              version,
              item_index,
              attempt,
              execution_id,
              job_id,
              status,
              runtime_status,
              target_reason,
              estimated_credit_cost,
              reserved_credits,
              failure_reason,
              input_snapshot,
              queued_at,
              failed_at,
              created_at,
              updated_at
            ) values (
              ${taskRun.id},
              ${taskRun.nodeExecutionId},
              ${nodeExecution.workflowId},
              ${nodeExecution.ownerUserId},
              ${taskRun.nodeId},
              ${taskRun.itemIndex},
              ${taskRun.attempt},
              ${taskRun.itemIndex},
              ${taskRun.attempt},
              ${taskRun.nodeExecutionId},
              ${taskRun.id},
              'queued',
              ${committedTaskRun.status},
              'node_run',
              ${estimatedCreditCost},
              ${hasReservedCredits ? estimatedCreditCost : null},
              ${committedTaskRun.failureReason ?? null},
              ${inputSnapshotJson(inputSnapshot)}::jsonb,
              ${hasReservedCredits ? sql`now()` : sql`null`},
              ${committedTaskRun.status === "FAILED" ? sql`now()` : sql`null`},
              now(),
              now()
            )
          `);
        }

        for (const dependency of plan.taskDependenciesToCreate) {
          await tx.execute(sql`
            insert into task_dependencies (
              id,
              child_task_run_id,
              required_parent_node_execution_id,
              required_parent_node_id,
              required_parent_item_index,
              source_handle,
              target_handle,
              target_node_id,
              resolved_parent_task_run_id,
              created_at
            ) values (
              ${buildTaskDependencyId(dependency)},
              ${dependency.childTaskRunId},
              ${dependency.parentNodeExecutionId},
              ${dependency.parentNodeId},
              ${dependency.parentItemIndex},
              ${dependency.sourceHandle ?? null},
              ${dependency.targetHandle ?? null},
              ${dependency.targetNodeId ?? dependency.childNodeId},
              ${
                queuedTaskRunFreezes
                  .get(dependency.childTaskRunId)
                  ?.resolvedParentTaskRunByDependencyId.get(
                    buildTaskDependencyId(dependency),
                  ) ?? null
              },
              now()
            )
          `);
          if (
            queuedTaskRunFreezes
              .get(dependency.childTaskRunId)
              ?.resolvedParentTaskRunByDependencyId.has(
                buildTaskDependencyId(dependency),
              )
          ) {
            await tx.execute(sql`
              update task_dependencies
              set resolved_at = now()
              where id = ${buildTaskDependencyId(dependency)}
            `);
          }
        }

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
      });
    },

    async claimQueuedTaskRun(
      command: ClaimQueuedTaskRunCommand,
    ): Promise<ClaimQueuedTaskRunResult> {
      const rows = rowsFromResult(
        await db.execute(sql`
          update task_runs
          set runtime_status = 'RUNNING', started_at = now(), updated_at = now()
          where id = ${command.taskRunId}
            and owner_user_id = ${command.ownerUserId}
            and attempt = ${command.attempt}
            and runtime_status = 'QUEUED'
          returning
            id as "taskRunId",
            node_execution_id as "nodeExecutionId",
            item_index as "itemIndex",
            attempt,
            input_snapshot as "inputSnapshot",
            runtime_status as status
        `),
      );
      const row = rows[0];

      if (!row) {
        return { claimed: false };
      }

      return {
        claimed: true,
        event: buildTaskStatusEvent({
          attempt: requireNumber(row.attempt),
          itemIndex: requireNumber(row.itemIndex),
          nodeExecutionId: requireString(row.nodeExecutionId),
          status: "RUNNING",
          taskRunId: requireString(row.taskRunId),
        }),
        inputSnapshot: requireExecutableTaskRunInputSnapshot(row.inputSnapshot),
      };
    },

    async settleTaskRunCompletion(
      command: SettleTaskRunCompletionCommand,
    ): Promise<SettleTaskRunCompletionResult> {
      const output = projectGeneratedAssetToTaskOutput([
        command.generatedAsset,
      ]);
      if (output.kind === "INVALID_PRIMARY_GENERATED_ASSET_COUNT") {
        throw new TypeError(output.message);
      }

      const finalStatus = command.reviewRequired
        ? "PENDING_REVIEW"
        : "APPROVED";
      const assetId = command.generatedAsset.assetId;
      const assetIdsJson = JSON.stringify([assetId]);

      return db.transaction(async (tx) => {
        const rows = rowsFromResult(
          await tx.execute(sql`
            update task_runs
            set
              runtime_status = ${finalStatus},
              asset_ids = ${assetIdsJson}::jsonb,
              cost_credits = ${command.finalCostCredits},
              finished_at = now(),
              updated_at = now()
            where id = ${command.taskRunId}
              and owner_user_id = ${command.ownerUserId}
              and attempt = ${command.attempt}
              and runtime_status = 'RUNNING'
            returning
              id as "taskRunId",
              node_execution_id as "nodeExecutionId",
              workflow_id as "workflowId",
              owner_user_id as "ownerUserId",
              item_index as "itemIndex",
              reserved_credits as "reservedCredits",
              attempt
          `),
        );
        const row = rows[0];

        if (!row) {
          return { settled: false };
        }

        await insertGeneratedAsset(tx, {
          asset: command.generatedAsset,
          ownerUserId: requireString(row.ownerUserId),
          taskRunId: requireString(row.taskRunId),
          workflowId: requireString(row.workflowId),
        });
        await refundTaskRunReservedCredits(tx, {
          amount: refundableReservedCredits(
            optionalNumber(row.reservedCredits),
            command.finalCostCredits,
          ),
          ownerUserId: requireString(row.ownerUserId),
          taskRunId: requireString(row.taskRunId),
          workflowId: requireString(row.workflowId),
        });

        const wakeUpJob =
          finalStatus === "APPROVED"
            ? buildWorkflowRuntimeWakeUpJobPayload({
                ownerUserId: command.ownerUserId,
                parentTaskRunId: command.taskRunId,
                workflowId: requireString(row.workflowId),
              })
            : null;

        return {
          settled: true,
          event: buildTaskStatusEvent({
            attempt: requireNumber(row.attempt),
            itemIndex: requireNumber(row.itemIndex),
            nodeExecutionId: requireString(row.nodeExecutionId),
            output,
            status: finalStatus,
            taskRunId: requireString(row.taskRunId),
          }),
          wakeUpJob,
        };
      });
    },

    async settleTaskRunFailure(
      command: SettleTaskRunFailureCommand,
    ): Promise<SettleTaskRunFailureResult> {
      const failureMessage =
        "message" in command.failureReason
          ? command.failureReason.message
          : null;

      return db.transaction(async (tx) => {
        const finalCostCredits = command.finalCostCredits ?? 0;
        const rows = rowsFromResult(
          await tx.execute(sql`
            update task_runs
            set
              runtime_status = 'FAILED',
              failure_reason = ${command.failureReason.type},
              error = ${failureMessage},
              cost_credits = ${finalCostCredits},
              failed_at = now(),
              updated_at = now()
            where id = ${command.taskRunId}
              and owner_user_id = ${command.ownerUserId}
              and attempt = ${command.attempt}
              and runtime_status = 'RUNNING'
            returning
              id as "taskRunId",
              node_execution_id as "nodeExecutionId",
              workflow_id as "workflowId",
              owner_user_id as "ownerUserId",
              item_index as "itemIndex",
              reserved_credits as "reservedCredits",
              attempt
          `),
        );
        const row = rows[0];

        if (!row) {
          return { settled: false };
        }

        await refundTaskRunReservedCredits(tx, {
          amount: refundableReservedCredits(
            optionalNumber(row.reservedCredits),
            finalCostCredits,
          ),
          ownerUserId: requireString(row.ownerUserId),
          taskRunId: requireString(row.taskRunId),
          workflowId: requireString(row.workflowId),
        });

        return {
          settled: true,
          event: buildTaskStatusEvent({
            attempt: requireNumber(row.attempt),
            failureReason: command.failureReason.type,
            itemIndex: requireNumber(row.itemIndex),
            nodeExecutionId: requireString(row.nodeExecutionId),
            status: "FAILED",
            taskRunId: requireString(row.taskRunId),
          }),
          wakeUpJob: buildWorkflowRuntimeWakeUpJobPayload({
            ownerUserId: requireString(row.ownerUserId),
            parentTaskRunId: requireString(row.taskRunId),
            workflowId: requireString(row.workflowId),
          }),
        };
      });
    },

    async approveTaskRun(
      command: DecideTaskRunReviewCommand,
    ): Promise<DecideTaskRunReviewResult> {
      const rows = rowsFromResult(
        await db.execute(sql`
          update task_runs
          set runtime_status = 'APPROVED', finished_at = now(), updated_at = now()
          where id = ${command.taskRunId}
            and owner_user_id = ${command.ownerUserId}
            and attempt = ${command.attempt}
            and runtime_status = 'PENDING_REVIEW'
          returning
            id as "taskRunId",
            node_execution_id as "nodeExecutionId",
            workflow_id as "workflowId",
            owner_user_id as "ownerUserId",
            item_index as "itemIndex",
            attempt
        `),
      );
      const row = rows[0];

      if (!row) {
        return { decided: false };
      }

      const taskRunId = requireString(row.taskRunId);

      return {
        decided: true,
        event: buildTaskStatusEvent({
          attempt: requireNumber(row.attempt),
          itemIndex: requireNumber(row.itemIndex),
          nodeExecutionId: requireString(row.nodeExecutionId),
          status: "APPROVED",
          taskRunId,
        }),
        wakeUpJob: buildWorkflowRuntimeWakeUpJobPayload({
          ownerUserId: requireString(row.ownerUserId),
          parentTaskRunId: taskRunId,
          workflowId: requireString(row.workflowId),
        }),
      };
    },

    async rejectTaskRunAndCreateRegeneration(
      command: RejectTaskRunAndCreateRegenerationCommand,
    ): Promise<RejectTaskRunAndCreateRegenerationResult> {
      return db.transaction(async (tx) => {
        const rows = rowsFromResult(
          await tx.execute(sql`
            update task_runs
            set runtime_status = 'REJECTED', finished_at = now(), updated_at = now()
            where id = ${command.taskRunId}
              and owner_user_id = ${command.ownerUserId}
              and attempt = ${command.attempt}
              and runtime_status = 'PENDING_REVIEW'
            returning
              id as "taskRunId",
              node_execution_id as "nodeExecutionId",
              workflow_id as "workflowId",
              owner_user_id as "ownerUserId",
              node_id as "nodeId",
              item_index as "itemIndex",
              attempt,
              execution_id as "executionId",
              target_reason as "targetReason",
              estimated_credit_cost as "estimatedCreditCost",
              input_snapshot as "inputSnapshot"
          `),
        );
        const row = rows[0];

        if (!row) {
          return { rejected: false };
        }

        const rejectedTaskRun = rejectedTaskRunFromRow(row);
        const dependencies = await loadTaskDependencyRequirements(
          tx,
          rejectedTaskRun.taskRunId,
        );
        const resolvedParents = await resolveLatestApprovedParents(
          tx,
          dependencies,
        );
        const nextAttempt = rejectedTaskRun.attempt + 1;
        const queueable = resolvedParents !== null;
        const inputSnapshot = queueable
          ? buildRepositoryInputSnapshot({
              attempt: nextAttempt,
              itemIndex: rejectedTaskRun.itemIndex,
              nodeExecutionId: rejectedTaskRun.nodeExecutionId,
              nodeId: rejectedTaskRun.nodeId,
              resolvedParents,
              targetNodeConfig: rejectedTaskRun.targetNodeConfig,
              taskRunId: command.newTaskRunId,
            })
          : null;
        const renderingFailure =
          inputSnapshot?.providerInput.kind === "non-executable-node";
        const hasReservedCredits =
          queueable && !renderingFailure
            ? await reserveInitialQueuedTaskRunCredits(tx, {
                amount: rejectedTaskRun.estimatedCreditCost,
                ownerUserId: rejectedTaskRun.ownerUserId,
                taskRunId: command.newTaskRunId,
                workflowId: rejectedTaskRun.workflowId,
              })
            : false;
        const newStatus = !queueable
          ? "WAITING_UPSTREAM"
          : renderingFailure
            ? "FAILED"
            : hasReservedCredits
              ? "QUEUED"
              : "FAILED";
        const failureReason = renderingFailure
          ? "EXECUTION_FAILED"
          : newStatus === "FAILED"
            ? "INSUFFICIENT_CREDITS"
            : null;

        await tx.execute(sql`
          insert into task_runs (
            id,
            node_execution_id,
            workflow_id,
            owner_user_id,
            node_id,
            output_index,
            version,
            item_index,
            attempt,
            execution_id,
            job_id,
            status,
            runtime_status,
            target_reason,
            estimated_credit_cost,
            reserved_credits,
            failure_reason,
            input_snapshot,
            queued_at,
            failed_at,
            created_at,
            updated_at
          ) values (
            ${command.newTaskRunId},
            ${rejectedTaskRun.nodeExecutionId},
            ${rejectedTaskRun.workflowId},
            ${rejectedTaskRun.ownerUserId},
            ${rejectedTaskRun.nodeId},
            ${rejectedTaskRun.itemIndex},
            ${nextAttempt},
            ${rejectedTaskRun.itemIndex},
            ${nextAttempt},
            ${rejectedTaskRun.executionId},
            ${command.newTaskRunId},
            'queued',
            ${newStatus},
            ${rejectedTaskRun.targetReason},
            ${rejectedTaskRun.estimatedCreditCost},
            ${hasReservedCredits ? rejectedTaskRun.estimatedCreditCost : null},
            ${failureReason},
            ${inputSnapshotJson(newStatus === "QUEUED" ? inputSnapshot : null)}::jsonb,
            ${newStatus === "QUEUED" ? sql`now()` : sql`null`},
            ${newStatus === "FAILED" ? sql`now()` : sql`null`},
            now(),
            now()
          )
        `);

        for (const dependency of dependencies) {
          const resolvedParentTaskRunId =
            newStatus === "QUEUED"
              ? (resolvedParents ?? []).find(
                  (parent) =>
                    parent.nodeExecutionId ===
                      dependency.requiredParentNodeExecutionId &&
                    parent.itemIndex === dependency.requiredParentItemIndex,
                )?.taskRunId
              : null;
          await tx.execute(sql`
            insert into task_dependencies (
              id,
              child_task_run_id,
              required_parent_node_execution_id,
              required_parent_node_id,
              required_parent_item_index,
              source_handle,
              target_handle,
              target_node_id,
              resolved_parent_task_run_id,
              created_at,
              resolved_at
            ) values (
              ${buildTaskDependencyId({
                childTaskRunId: command.newTaskRunId,
                parentItemIndex: dependency.requiredParentItemIndex,
                parentNodeExecutionId: dependency.requiredParentNodeExecutionId,
                sourceHandle: dependency.sourceHandle,
                targetHandle: dependency.targetHandle,
              })},
              ${command.newTaskRunId},
              ${dependency.requiredParentNodeExecutionId},
              ${dependency.requiredParentNodeId},
              ${dependency.requiredParentItemIndex},
              ${dependency.sourceHandle},
              ${dependency.targetHandle},
              ${dependency.targetNodeId},
              ${resolvedParentTaskRunId ?? null},
              now(),
              ${resolvedParentTaskRunId ? sql`now()` : sql`null`}
            )
          `);
        }

        const newTaskEvent = buildTaskStatusEvent({
          attempt: nextAttempt,
          ...(failureReason ? { failureReason } : {}),
          itemIndex: rejectedTaskRun.itemIndex,
          nodeExecutionId: rejectedTaskRun.nodeExecutionId,
          status: newStatus,
          taskRunId: command.newTaskRunId,
        });

        return {
          executionJob:
            newStatus === "QUEUED"
              ? buildWorkflowRuntimeExecutionJobPayload({
                  attempt: nextAttempt,
                  itemIndex: rejectedTaskRun.itemIndex,
                  nodeExecutionId: rejectedTaskRun.nodeExecutionId,
                  ownerUserId: rejectedTaskRun.ownerUserId,
                  taskRunId: command.newTaskRunId,
                  workflowId: rejectedTaskRun.workflowId,
                })
              : null,
          rejected: true,
          taskStatusEvents: [
            buildTaskStatusEvent({
              attempt: rejectedTaskRun.attempt,
              itemIndex: rejectedTaskRun.itemIndex,
              nodeExecutionId: rejectedTaskRun.nodeExecutionId,
              status: "REJECTED",
              taskRunId: rejectedTaskRun.taskRunId,
            }),
            newTaskEvent,
          ],
        };
      });
    },

    async cancelTaskRun(
      command: DecideTaskRunReviewCommand,
    ): Promise<DecideTaskRunReviewResult> {
      return db.transaction(async (tx) => {
        const rows = rowsFromResult(
          await tx.execute(sql`
            update task_runs
            set runtime_status = 'CANCELLED', finished_at = now(), updated_at = now()
            where id = ${command.taskRunId}
              and owner_user_id = ${command.ownerUserId}
              and attempt = ${command.attempt}
              and runtime_status in (
                'WAITING_UPSTREAM',
                'QUEUED',
                'RUNNING',
                'PENDING_REVIEW'
              )
            returning
              id as "taskRunId",
              node_execution_id as "nodeExecutionId",
              workflow_id as "workflowId",
              owner_user_id as "ownerUserId",
              item_index as "itemIndex",
              reserved_credits as "reservedCredits",
              cost_credits as "costCredits",
              attempt
          `),
        );
        const row = rows[0];

        if (!row) {
          return { decided: false };
        }

        const taskRunId = requireString(row.taskRunId);
        await refundTaskRunReservedCredits(tx, {
          amount: refundableReservedCredits(
            optionalNumber(row.reservedCredits),
            requireNumber(row.costCredits),
          ),
          ownerUserId: requireString(row.ownerUserId),
          taskRunId,
          workflowId: requireString(row.workflowId),
        });

        return {
          decided: true,
          event: buildTaskStatusEvent({
            attempt: requireNumber(row.attempt),
            itemIndex: requireNumber(row.itemIndex),
            nodeExecutionId: requireString(row.nodeExecutionId),
            status: "CANCELLED",
            taskRunId,
          }),
          wakeUpJob: buildWorkflowRuntimeWakeUpJobPayload({
            ownerUserId: requireString(row.ownerUserId),
            parentTaskRunId: taskRunId,
            workflowId: requireString(row.workflowId),
          }),
        };
      });
    },

    async listQueuedTaskRunJobs(
      command: ListQueuedTaskRunJobsCommand,
    ): Promise<readonly WorkflowRuntimeExecutionJobPayload[]> {
      const rows = rowsFromResult(
        await db.execute(sql`
          select
            id as "taskRunId",
            node_execution_id as "nodeExecutionId",
            workflow_id as "workflowId",
            owner_user_id as "ownerUserId",
            item_index as "itemIndex",
            attempt,
            input_snapshot as "inputSnapshot"
          from task_runs
          where runtime_status = 'QUEUED'
            and attempt is not null
            and input_snapshot is not null
          order by updated_at asc, id asc
          limit ${command.limit}
        `),
      );

      return rows.map((row) => {
        const taskRunId = requireString(row.taskRunId);
        const attempt = requireNumber(row.attempt);

        return buildWorkflowRuntimeExecutionJobPayload({
          attempt,
          itemIndex: requireNumber(row.itemIndex),
          nodeExecutionId: requireString(row.nodeExecutionId),
          ownerUserId: requireString(row.ownerUserId),
          taskRunId,
          workflowId: requireString(row.workflowId),
        });
      });
    },

    async wakeUpTaskRunChildren(
      command: WakeUpTaskRunChildrenRepositoryCommand,
    ): Promise<WakeUpTaskRunChildrenRepositoryResult> {
      return wakeUpTaskRunChildrenInRepository(db, command);
    },

    async getRuntimeTaskRunsForNodeExecution(command: {
      readonly nodeExecutionId: string;
    }): Promise<readonly RuntimeTaskRunRow[]> {
      const rows = rowsFromResult(
        await db.execute(sql`
          select
            id as "taskRunId",
            node_execution_id as "nodeExecutionId",
            workflow_id as "workflowId",
            owner_user_id as "ownerUserId",
            item_index as "itemIndex",
            attempt,
            runtime_status as "runtimeStatus",
            reserved_credits as "reservedCredits",
            input_snapshot as "inputSnapshot"
          from task_runs
          where node_execution_id = ${command.nodeExecutionId}
          order by item_index asc, attempt asc, id asc
        `),
      );

      return rows.map((row) => ({
        attempt: requireNumber(row.attempt),
        inputSnapshot: optionalTaskRunInputSnapshot(row.inputSnapshot),
        itemIndex: requireNumber(row.itemIndex),
        nodeExecutionId: requireString(row.nodeExecutionId),
        ownerUserId: requireString(row.ownerUserId),
        reservedCredits: optionalNumber(row.reservedCredits),
        runtimeStatus: requireString(row.runtimeStatus),
        taskRunId: requireString(row.taskRunId),
        workflowId: requireString(row.workflowId),
      }));
    },

    async getTaskDependenciesForChild(command: {
      readonly childTaskRunId: string;
    }): Promise<readonly TaskDependencyRow[]> {
      const rows = rowsFromResult(
        await db.execute(sql`
          select
            child_task_run_id as "childTaskRunId",
            required_parent_node_execution_id as "requiredParentNodeExecutionId",
            required_parent_node_id as "requiredParentNodeId",
            required_parent_item_index as "requiredParentItemIndex",
            source_handle as "sourceHandle",
            target_handle as "targetHandle",
            target_node_id as "targetNodeId",
            resolved_parent_task_run_id as "resolvedParentTaskRunId"
          from task_dependencies
          where child_task_run_id = ${command.childTaskRunId}
          order by required_parent_node_execution_id asc,
            required_parent_item_index asc,
            source_handle asc nulls first,
            target_handle asc nulls first
        `),
      );

      return rows.map((row) => {
        const requiredParentNodeId = optionalString(row.requiredParentNodeId);
        const targetNodeId = optionalString(row.targetNodeId);
        const hasAddress = Boolean(
          requiredParentNodeId ??
            targetNodeId ??
            row.sourceHandle ??
            row.targetHandle,
        );

        return {
          childTaskRunId: requireString(row.childTaskRunId),
          requiredParentItemIndex: requireNumber(row.requiredParentItemIndex),
          ...(requiredParentNodeId ? { requiredParentNodeId } : {}),
          requiredParentNodeExecutionId: requireString(
            row.requiredParentNodeExecutionId,
          ),
          resolvedParentTaskRunId: optionalString(row.resolvedParentTaskRunId),
          ...(hasAddress
            ? { sourceHandle: optionalString(row.sourceHandle) }
            : {}),
          ...(hasAddress
            ? { targetHandle: optionalString(row.targetHandle) }
            : {}),
          ...(targetNodeId ? { targetNodeId } : {}),
        };
      });
    },

    async getCreditLedgerForUser(command: {
      readonly ownerUserId: string;
    }): Promise<{
      readonly creditBalance: number;
      readonly ledgerEntries: readonly CreditLedgerEntrySnapshot[];
    }> {
      const userRows = rowsFromResult(
        await db.execute(sql`
          select credit_balance as "creditBalance"
          from "user"
          where id = ${command.ownerUserId}
        `),
      );
      const userRow = userRows[0];
      if (!userRow) {
        throw new TypeError(`Missing owner user ${command.ownerUserId}`);
      }

      const ledgerRows = rowsFromResult(
        await db.execute(sql`
          select
            amount,
            balance_after as "balanceAfter",
            kind,
            source_key as "sourceKey"
          from credit_ledger_entries
          where user_id = ${command.ownerUserId}
          order by created_at asc, id asc
        `),
      );

      return {
        creditBalance: requireNumber(userRow.creditBalance),
        ledgerEntries: ledgerRows.map((row) => ({
          amount: requireNumber(row.amount),
          balanceAfter: requireNumber(row.balanceAfter),
          kind: requireString(row.kind),
          sourceKey: requireString(row.sourceKey),
        })),
      };
    },
  };
}

function countPlannedTaskRunsForNodeExecution(
  plan: WorkflowRunPlan,
  nodeExecutionId: string,
) {
  return plan.taskRunsToCreate.filter(
    (taskRun) => taskRun.nodeExecutionId === nodeExecutionId,
  ).length;
}

function rejectedTaskRunFromRow(row: QueryRow): RejectedTaskRunRow {
  const inputSnapshot = requireTaskRunInputSnapshot(row.inputSnapshot);
  return {
    attempt: requireNumber(row.attempt),
    estimatedCreditCost: optionalNumber(row.estimatedCreditCost) ?? 0,
    executionId: requireString(row.executionId),
    itemIndex: requireNumber(row.itemIndex),
    nodeExecutionId: requireString(row.nodeExecutionId),
    nodeId: requireString(row.nodeId),
    ownerUserId: requireString(row.ownerUserId),
    targetReason: requireString(row.targetReason),
    targetNodeConfig: inputSnapshot.targetNodeConfig,
    taskRunId: requireString(row.taskRunId),
    workflowId: requireString(row.workflowId),
  };
}

function renderingFailureReasonFromFreeze(
  freeze: QueuedTaskRunFreeze | undefined,
): "EXECUTION_FAILED" | undefined {
  return freeze?.inputSnapshot.providerInput.kind === "non-executable-node"
    ? "EXECUTION_FAILED"
    : undefined;
}

function inputSnapshotJson(
  snapshot: TaskRunInputSnapshot | null,
): string | null {
  return snapshot ? JSON.stringify(snapshot) : null;
}

async function loadTaskDependencyRequirements(
  db: DbExecutor,
  childTaskRunId: string,
): Promise<readonly TaskDependencyRow[]> {
  const rows = rowsFromResult(
    await db.execute(sql`
      select
        child_task_run_id as "childTaskRunId",
        required_parent_node_execution_id as "requiredParentNodeExecutionId",
        required_parent_node_id as "requiredParentNodeId",
        required_parent_item_index as "requiredParentItemIndex",
        source_handle as "sourceHandle",
        target_handle as "targetHandle",
        target_node_id as "targetNodeId",
        resolved_parent_task_run_id as "resolvedParentTaskRunId"
      from task_dependencies
      where child_task_run_id = ${childTaskRunId}
      order by required_parent_node_execution_id asc,
        required_parent_item_index asc,
        source_handle asc nulls first,
        target_handle asc nulls first
      for update
    `),
  );

  return rows.map((row) => ({
    childTaskRunId: requireString(row.childTaskRunId),
    requiredParentItemIndex: requireNumber(row.requiredParentItemIndex),
    requiredParentNodeId: optionalString(row.requiredParentNodeId),
    requiredParentNodeExecutionId: requireString(
      row.requiredParentNodeExecutionId,
    ),
    resolvedParentTaskRunId: optionalString(row.resolvedParentTaskRunId),
    sourceHandle: optionalString(row.sourceHandle),
    targetHandle: optionalString(row.targetHandle),
    targetNodeId: optionalString(row.targetNodeId),
  }));
}

async function resolveLatestApprovedParents(
  db: DbExecutor,
  dependencies: readonly TaskDependencyRow[],
): Promise<readonly ResolvedParentTaskRunSnapshot[] | null> {
  const parents: ResolvedParentTaskRunSnapshot[] = [];

  for (const dependency of dependencies) {
    const parent = await loadLatestParentTaskRun(db, dependency);
    if (!parent || parent.runtimeStatus !== "APPROVED") {
      return null;
    }
    parents.push({
      attempt: parent.attempt,
      itemIndex: parent.itemIndex,
      nodeExecutionId: parent.nodeExecutionId,
      ...(parent.output ? { output: parent.output } : {}),
      ...dependencyAddressProvenance(dependency),
      taskRunId: parent.taskRunId,
    });
  }

  return parents;
}

async function loadLatestParentTaskRun(
  db: DbExecutor,
  dependency: TaskDependencyRow,
): Promise<
  (ResolvedParentTaskRunSnapshot & { readonly runtimeStatus: string }) | null
> {
  const rows = rowsFromResult(
    await db.execute(sql`
      select
        id as "taskRunId",
        node_execution_id as "nodeExecutionId",
        item_index as "itemIndex",
        attempt,
        runtime_status as "runtimeStatus"
      from task_runs
      where node_execution_id = ${dependency.requiredParentNodeExecutionId}
        and item_index = ${dependency.requiredParentItemIndex}
        and runtime_status is not null
      order by attempt desc, id desc
      limit 1
      for update
    `),
  );
  const row = rows[0];
  if (!row) {
    return null;
  }

  const taskRunId = requireString(row.taskRunId);
  const output = await loadGeneratedOutputForTaskRun(db, taskRunId);

  return {
    attempt: requireNumber(row.attempt),
    itemIndex: requireNumber(row.itemIndex),
    nodeExecutionId: requireString(row.nodeExecutionId),
    ...(output ? { output } : {}),
    runtimeStatus: requireString(row.runtimeStatus),
    taskRunId,
  };
}

function buildRepositoryInputSnapshot(input: {
  readonly attempt: number;
  readonly itemIndex: number;
  readonly nodeExecutionId: string;
  readonly nodeId: string;
  readonly resolvedParents: readonly ResolvedParentTaskRunSnapshot[] | null;
  readonly targetNodeConfig: TaskRunInputSnapshot["targetNodeConfig"];
  readonly taskRunId: string;
}): TaskRunInputSnapshot {
  return buildTaskRunInputSnapshot({
    attempt: input.attempt,
    itemIndex: input.itemIndex,
    nodeExecutionId: input.nodeExecutionId,
    nodeId: input.nodeId,
    resolvedParentTaskRuns: input.resolvedParents ?? [],
    targetNodeConfig: input.targetNodeConfig,
    taskRunId: input.taskRunId,
  });
}

function dependencyAddressProvenance(input: {
  readonly requiredParentNodeId?: string | null;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
  readonly targetNodeId?: string | null;
}) {
  const hasAddress = Boolean(
    input.requiredParentNodeId ??
      input.targetNodeId ??
      input.sourceHandle ??
      input.targetHandle,
  );
  if (!hasAddress) {
    return {} satisfies Partial<ResolvedParentTaskRunSnapshot>;
  }

  return {
    ...(input.requiredParentNodeId
      ? { sourceNodeId: input.requiredParentNodeId }
      : {}),
    ...(input.targetNodeId ? { targetNodeId: input.targetNodeId } : {}),
    sourceHandle: input.sourceHandle ?? null,
    targetHandle: input.targetHandle ?? null,
  } satisfies Partial<ResolvedParentTaskRunSnapshot>;
}

function nodeExecutionIdsRequiredByTaskRuns(plan: WorkflowRunPlan) {
  return new Set(
    plan.taskRunsToCreate.map((taskRun) => taskRun.nodeExecutionId),
  );
}

async function loadNodeExecutionIdentity(
  db: DbExecutor,
  nodeExecutionId: string,
): Promise<NodeExecutionIdentity> {
  const rows = rowsFromResult(
    await db.execute(sql`
      select
        id,
        workflow_id as "workflowId",
        owner_user_id as "ownerUserId"
      from node_executions
      where id = ${nodeExecutionId}
      limit 1
    `),
  );
  const row = rows[0];
  if (!row) {
    throw new TypeError(`Missing Node Execution ${nodeExecutionId}`);
  }

  return {
    id: requireString(row.id),
    ownerUserId: requireString(row.ownerUserId),
    workflowId: requireString(row.workflowId),
  };
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

async function buildQueuedTaskRunFreezes(
  db: DbExecutor,
  plan: WorkflowRunPlan,
): Promise<ReadonlyMap<string, QueuedTaskRunFreeze>> {
  const dependenciesByChildTaskRunId = new Map<
    string,
    WorkflowRunPlan["taskDependenciesToCreate"][number][]
  >(plan.taskRunsToCreate.map((taskRun) => [taskRun.id, []]));

  for (const dependency of plan.taskDependenciesToCreate) {
    const dependencies = dependenciesByChildTaskRunId.get(
      dependency.childTaskRunId,
    );
    if (dependencies) {
      dependencies.push(dependency);
    }
  }

  const freezes = new Map<string, QueuedTaskRunFreeze>();
  for (const taskRun of plan.taskRunsToCreate) {
    if (taskRun.status !== "QUEUED") {
      continue;
    }

    const resolvedParents: ResolvedParentTaskRunSnapshot[] = [];
    const resolvedParentTaskRunByDependencyId = new Map<string, string>();
    for (const dependency of dependenciesByChildTaskRunId.get(taskRun.id) ??
      []) {
      const parent = await loadLatestApprovedParentTaskRunForCommit(db, {
        childTaskRunId: taskRun.id,
        parentItemIndex: dependency.parentItemIndex,
        parentNodeExecutionId: dependency.parentNodeExecutionId,
        sourceHandle: dependency.sourceHandle,
        targetHandle: dependency.targetHandle,
      });
      resolvedParents.push({
        ...parent,
        ...dependencyAddressProvenance({
          requiredParentNodeId: dependency.parentNodeId,
          sourceHandle: dependency.sourceHandle ?? null,
          targetHandle: dependency.targetHandle ?? null,
          targetNodeId: dependency.targetNodeId ?? dependency.childNodeId,
        }),
      });
      resolvedParentTaskRunByDependencyId.set(
        buildTaskDependencyId(dependency),
        parent.taskRunId,
      );
    }

    freezes.set(taskRun.id, {
      inputSnapshot: buildRepositoryInputSnapshot({
        attempt: taskRun.attempt,
        itemIndex: taskRun.itemIndex,
        nodeExecutionId: taskRun.nodeExecutionId,
        nodeId: taskRun.nodeId,
        resolvedParents,
        targetNodeConfig: taskRun.targetNodeConfig,
        taskRunId: taskRun.id,
      }),
      resolvedParentTaskRunByDependencyId,
    });
  }

  return freezes;
}

async function loadLatestApprovedParentTaskRunForCommit(
  db: DbExecutor,
  input: {
    readonly childTaskRunId: string;
    readonly parentItemIndex: number;
    readonly parentNodeExecutionId: string;
    readonly sourceHandle?: string | null;
    readonly targetHandle?: string | null;
  },
): Promise<ResolvedParentTaskRunSnapshot> {
  const rows = rowsFromResult(
    await db.execute(sql`
      select
        id as "taskRunId",
        node_execution_id as "nodeExecutionId",
        item_index as "itemIndex",
        attempt,
        runtime_status as "runtimeStatus"
      from task_runs
      where node_execution_id = ${input.parentNodeExecutionId}
        and item_index = ${input.parentItemIndex}
        and runtime_status is not null
      order by attempt desc, id desc
      limit 1
      for update
    `),
  );
  const row = rows[0];
  if (!row || row.runtimeStatus !== "APPROVED") {
    throw new TypeError(
      `Cannot queue Task Run ${input.childTaskRunId}: latest required parent slot is not APPROVED`,
    );
  }

  const taskRunId = requireString(row.taskRunId);
  const output = await loadGeneratedOutputForTaskRun(db, taskRunId);

  return {
    attempt: requireNumber(row.attempt),
    itemIndex: requireNumber(row.itemIndex),
    nodeExecutionId: requireString(row.nodeExecutionId),
    ...(output ? { output } : {}),
    taskRunId,
  };
}

async function loadGeneratedOutputForTaskRun(
  db: DbExecutor,
  taskRunId: string,
): Promise<ResolvedParentTaskRunSnapshot["output"] | undefined> {
  const rows = rowsFromResult(
    await db.execute(sql`
      select
        id as "assetId",
        kind,
        cdn_url as "cdnUrl",
        text_content as "text",
        mime_type as "contentType"
      from assets
      where task_run_id = ${taskRunId}
        and source = 'generated'
        and deleted_at is null
      order by created_at asc, id asc
    `),
  );
  const assets = rows.flatMap((row): GeneratedAsset[] => {
    const kind = row.kind;
    if (kind === "text") {
      return [
        {
          assetId: requireString(row.assetId),
          kind,
          text: requireString(row.text),
        },
      ];
    }
    if (kind === "image" || kind === "video") {
      return [
        {
          assetId: requireString(row.assetId),
          cdnUrl: requireString(row.cdnUrl),
          contentType: requireString(row.contentType),
          kind,
        },
      ];
    }

    return [];
  });
  const output = projectGeneratedAssetToTaskOutput(assets);

  return output.kind === "INVALID_PRIMARY_GENERATED_ASSET_COUNT"
    ? undefined
    : output;
}

async function insertGeneratedAsset(
  db: DbExecutor,
  input: {
    readonly asset: GeneratedPrimaryAssetInput;
    readonly ownerUserId: string;
    readonly taskRunId: string;
    readonly workflowId: string;
  },
): Promise<void> {
  const { asset } = input;
  await db.execute(sql`
    insert into assets (
      id,
      owner_user_id,
      workflow_id,
      source,
      kind,
      task_run_id,
      storage_provider,
      storage_key,
      cdn_url,
      text_content,
      mime_type,
      file_name,
      size_bytes,
      model,
      external_uri,
      created_at
    ) values (
      ${asset.assetId},
      ${input.ownerUserId},
      ${input.workflowId},
      'generated',
      ${asset.kind},
      ${input.taskRunId},
      ${asset.storageProvider},
      ${asset.storageKey ?? null},
      ${"cdnUrl" in asset ? asset.cdnUrl : null},
      ${"text" in asset ? asset.text : null},
      ${asset.contentType},
      ${asset.fileName},
      ${asset.sizeBytes},
      ${asset.model ?? null},
      ${asset.externalUri ?? null},
      now()
    )
  `);
}

async function reserveInitialQueuedTaskRunCredits(
  db: DbExecutor,
  input: {
    readonly amount: number;
    readonly ownerUserId: string;
    readonly taskRunId: string;
    readonly workflowId: string;
  },
): Promise<boolean> {
  if (input.amount <= 0) {
    return true;
  }

  const lockedUser = rowsFromResult(
    await db.execute(sql`
      select credit_balance as "creditBalance"
      from "user"
      where id = ${input.ownerUserId}
      for update
    `),
  );
  const user = lockedUser[0];
  if (!user) {
    throw new TypeError(`Missing owner user ${input.ownerUserId}`);
  }
  if (requireNumber(user.creditBalance) < input.amount) {
    return false;
  }

  const sourceKey = buildCreditReservationSourceKey(input.taskRunId);
  const rows = rowsFromResult(
    await db.execute(sql`
      update "user"
      set credit_balance = credit_balance - ${input.amount}
      where id = ${input.ownerUserId}
      returning credit_balance as "creditBalance"
    `),
  );
  const row = rows[0];
  if (!row) {
    throw new TypeError(`Missing owner user ${input.ownerUserId}`);
  }

  await db.execute(sql`
    insert into credit_ledger_entries (
      id,
      user_id,
      execution_id,
      kind,
      amount,
      balance_after,
      reason,
      source_key,
      created_at
    ) values (
      ${sourceKey},
      ${input.ownerUserId},
      ${input.workflowId},
      'debit',
      ${input.amount},
      ${requireNumber(row.creditBalance)},
      'task_run_credit_reservation',
      ${sourceKey},
      now()
    )
  `);

  return true;
}

async function refundTaskRunReservedCredits(
  db: DbExecutor,
  input: {
    readonly amount: number;
    readonly ownerUserId: string;
    readonly taskRunId: string;
    readonly workflowId: string;
  },
): Promise<void> {
  if (input.amount <= 0) {
    return;
  }

  const sourceKey = buildCreditRefundSourceKey(input.taskRunId);
  const lockedUser = rowsFromResult(
    await db.execute(sql`
      select id
      from "user"
      where id = ${input.ownerUserId}
      for update
    `),
  );
  if (!lockedUser[0]) {
    throw new TypeError(`Missing owner user ${input.ownerUserId}`);
  }

  const existing = rowsFromResult(
    await db.execute(sql`
      select id
      from credit_ledger_entries
      where source_key = ${sourceKey}
      limit 1
    `),
  );
  if (existing.length > 0) {
    return;
  }

  const rows = rowsFromResult(
    await db.execute(sql`
      update "user"
      set credit_balance = credit_balance + ${input.amount}
      where id = ${input.ownerUserId}
      returning credit_balance as "creditBalance"
    `),
  );
  const row = rows[0];
  if (!row) {
    throw new TypeError(`Missing owner user ${input.ownerUserId}`);
  }

  await db.execute(sql`
    insert into credit_ledger_entries (
      id,
      user_id,
      execution_id,
      kind,
      amount,
      balance_after,
      reason,
      source_key,
      created_at
    ) values (
      ${sourceKey},
      ${input.ownerUserId},
      ${input.workflowId},
      'refund',
      ${input.amount},
      ${requireNumber(row.creditBalance)},
      'task_run_credit_refund',
      ${sourceKey},
      now()
    ) on conflict (source_key) do nothing
  `);
}

function refundableReservedCredits(
  reservedCredits: number | null,
  finalCostCredits: number,
): number {
  return Math.max((reservedCredits ?? 0) - finalCostCredits, 0);
}

function buildCreditRefundSourceKey(taskRunId: string): string {
  return `task_run:${taskRunId}:credit_refund`;
}

function buildCreditReservationSourceKey(taskRunId: string): string {
  return `task_run:${taskRunId}:credit_reservation`;
}

function rowsFromResult(result: unknown): readonly QueryRow[] {
  if (Array.isArray(result)) {
    return result.filter(isQueryRow);
  }

  if (isQueryRow(result) && Array.isArray(result.rows)) {
    return result.rows.filter(isQueryRow);
  }

  return [];
}

function isQueryRow(value: unknown): value is QueryRow {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Expected non-empty database string value");
  }

  return value;
}

function optionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : requireString(value);
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

function optionalNumber(value: unknown): number | null {
  return value === null ? null : requireNumber(value);
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
