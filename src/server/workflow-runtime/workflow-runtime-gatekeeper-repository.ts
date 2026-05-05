import { type SQL, sql } from "drizzle-orm";
import type { WorkflowAsset } from "~/lib/workflow/types";
import {
  type GeneratedAsset,
  projectGeneratedAssetToTaskOutput,
} from "~/lib/workflow-runtime/assets/generated-asset-projection";
import type {
  TaskRunFailureReason,
  TaskRunStatus,
} from "~/lib/workflow-runtime/domain/task-run-state";
import {
  isTaskRunInputSnapshot,
  type TaskRunInputSnapshot,
} from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
import {
  wakeUpTaskRunChildren as runWakeUpTaskRunChildren,
  type TaskRunGatekeeperDependency,
  type TaskRunGatekeeperState,
  type TaskRunGatekeeperTaskRun,
} from "~/lib/workflow-runtime/gatekeeper/task-run-gatekeeper";
import type { TaskStatusEvent } from "~/lib/workflow-runtime/runtime/task-status-events";
import {
  buildWorkflowRuntimeExecutionJobPayload,
  type WorkflowRuntimeExecutionJobPayload,
} from "~/server/workflow-runtime/workflow-runtime-queue";

type DbExecutor = {
  readonly execute: (query: SQL) => Promise<unknown>;
};

type DbLike = DbExecutor & {
  readonly transaction: <T>(
    callback: (tx: DbExecutor) => Promise<T>,
  ) => Promise<T>;
};

export type WakeUpTaskRunChildrenRepositoryCommand = {
  readonly ownerUserId: string;
  readonly settledParentTaskRunId: string;
};

export type WakeUpTaskRunChildrenRepositoryResult = {
  readonly executionJobs: readonly WorkflowRuntimeExecutionJobPayload[];
  readonly taskStatusEvents: readonly TaskStatusEvent[];
};

type GatekeeperTaskRunRow = {
  readonly attempt: number;
  readonly estimatedCreditCost: number;
  readonly failureReason: TaskRunFailureReason | undefined;
  readonly inputSnapshot: TaskRunInputSnapshot | undefined;
  readonly itemIndex: number;
  readonly nodeId: string;
  readonly nodeExecutionId: string;
  readonly ownerUserId: string;
  readonly asset: WorkflowAsset | undefined;
  readonly output: TaskRunGatekeeperTaskRun["output"];
  readonly reservedCredits: number | undefined;
  readonly status: TaskRunStatus;
  readonly taskRunId: string;
  readonly workflowId: string;
};

type QueryRow = Record<string, unknown>;

export async function wakeUpTaskRunChildrenInRepository(
  db: DbLike,
  command: WakeUpTaskRunChildrenRepositoryCommand,
): Promise<WakeUpTaskRunChildrenRepositoryResult> {
  return db.transaction(async (tx) => {
    const parent = await loadGatekeeperParentTaskRun(tx, command);
    if (!parent) {
      return { executionJobs: [], taskStatusEvents: [] };
    }

    const taskRuns = await loadGatekeeperTaskRuns(tx, parent);
    const dependencies = await loadGatekeeperDependencies(tx, parent);
    const creditBalance = await loadOwnerCreditBalance(tx, command.ownerUserId);
    const gatekeeperTaskRuns = taskRuns.map(projectGatekeeperTaskRun);
    const initialTaskRuns = new Map(
      gatekeeperTaskRuns.map((taskRun) => [taskRun.id, taskRun]),
    );
    const initialDependencies = new Map(
      dependencies.map((dependency) => [
        taskDependencyKey(dependency),
        dependency,
      ]),
    );
    const result = runWakeUpTaskRunChildren(
      { creditBalance, dependencies, taskRuns: gatekeeperTaskRuns },
      { settledParentTaskRunId: command.settledParentTaskRunId },
    );

    const persistedTaskRunIds = await persistGatekeeperResult(tx, {
      initialDependencies,
      initialTaskRuns,
      ownerUserId: command.ownerUserId,
      resultState: result.state,
      taskRunRows: taskRuns,
    });

    const taskRunRowsById = new Map(
      taskRuns.map((taskRun) => [taskRun.taskRunId, taskRun]),
    );
    return {
      executionJobs: result.executionJobs.flatMap((job) => {
        if (!persistedTaskRunIds.has(job.taskRunId)) {
          return [];
        }
        const taskRun = requireTaskRunRow(taskRunRowsById, job.taskRunId);
        return buildWorkflowRuntimeExecutionJobPayload({
          attempt: job.attempt,
          itemIndex: taskRun.itemIndex,
          nodeExecutionId: taskRun.nodeExecutionId,
          ownerUserId: taskRun.ownerUserId,
          taskRunId: job.taskRunId,
          workflowId: taskRun.workflowId,
        });
      }),
      taskStatusEvents: result.taskStatusEvents.filter((event) =>
        persistedTaskRunIds.has(event.taskRunId),
      ),
    };
  });
}

async function loadGatekeeperParentTaskRun(
  db: DbExecutor,
  command: WakeUpTaskRunChildrenRepositoryCommand,
): Promise<{
  readonly ownerUserId: string;
  readonly workflowId: string;
} | null> {
  const rows = rowsFromResult(
    await db.execute(sql`
      select owner_user_id as "ownerUserId", workflow_id as "workflowId"
      from task_runs
      where id = ${command.settledParentTaskRunId}
        and owner_user_id = ${command.ownerUserId}
        and runtime_status is not null
      limit 1
    `),
  );
  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    ownerUserId: requireString(row.ownerUserId),
    workflowId: requireString(row.workflowId),
  };
}

async function loadGatekeeperTaskRuns(
  db: DbExecutor,
  scope: { readonly ownerUserId: string; readonly workflowId: string },
): Promise<readonly GatekeeperTaskRunRow[]> {
  const rows = rowsFromResult(
    await db.execute(sql`
      select
        id as "taskRunId",
        node_execution_id as "nodeExecutionId",
        node_id as "nodeId",
        workflow_id as "workflowId",
        owner_user_id as "ownerUserId",
        item_index as "itemIndex",
        attempt,
        runtime_status as status,
        coalesce(estimated_credit_cost, reserved_credits, 0) as "estimatedCreditCost",
        reserved_credits as "reservedCredits",
        failure_reason as "failureReason",
        error,
        input_snapshot as "inputSnapshot"
      from task_runs
      where owner_user_id = ${scope.ownerUserId}
        and workflow_id = ${scope.workflowId}
        and runtime_status is not null
      order by node_execution_id asc, item_index asc, attempt asc, id asc
    `),
  );

  const outputs = await loadGeneratedOutputsForTaskRuns(
    db,
    rows.map((row) => requireString(row.taskRunId)),
  );

  return rows.map((row) => ({
    attempt: requireNumber(row.attempt),
    estimatedCreditCost: requireNumber(row.estimatedCreditCost),
    failureReason: optionalTaskRunFailureReason(row.failureReason, row.error),
    inputSnapshot: optionalTaskRunInputSnapshot(row.inputSnapshot) ?? undefined,
    itemIndex: requireNumber(row.itemIndex),
    nodeId: requireString(row.nodeId),
    nodeExecutionId: requireString(row.nodeExecutionId),
    ownerUserId: requireString(row.ownerUserId),
    asset: outputs.get(requireString(row.taskRunId))?.asset,
    output: outputs.get(requireString(row.taskRunId))?.output,
    reservedCredits: optionalNumber(row.reservedCredits) ?? undefined,
    status: requireTaskRunStatus(row.status),
    taskRunId: requireString(row.taskRunId),
    workflowId: requireString(row.workflowId),
  }));
}

async function loadGatekeeperDependencies(
  db: DbExecutor,
  scope: { readonly ownerUserId: string; readonly workflowId: string },
): Promise<readonly TaskRunGatekeeperDependency[]> {
  const rows = rowsFromResult(
    await db.execute(sql`
      select
        dependency.child_task_run_id as "childTaskRunId",
        dependency.required_parent_node_execution_id as "requiredParentNodeExecutionId",
        dependency.required_parent_node_id as "requiredParentNodeId",
        dependency.required_parent_item_index as "requiredParentItemIndex",
        dependency.source_handle as "sourceHandle",
        dependency.target_handle as "targetHandle",
        dependency.target_node_id as "targetNodeId",
        dependency.resolved_parent_task_run_id as "resolvedParentTaskRunId"
      from task_dependencies dependency
      inner join task_runs child on child.id = dependency.child_task_run_id
      where child.owner_user_id = ${scope.ownerUserId}
        and child.workflow_id = ${scope.workflowId}
      order by dependency.child_task_run_id asc,
        dependency.required_parent_node_execution_id asc,
        dependency.required_parent_item_index asc,
        dependency.source_handle asc nulls first,
        dependency.target_handle asc nulls first
    `),
  );

  return rows.map((row) => ({
    childTaskRunId: requireString(row.childTaskRunId),
    requiredParentItemIndex: requireNumber(row.requiredParentItemIndex),
    requiredParentNodeId: requireString(row.requiredParentNodeId),
    requiredParentNodeExecutionId: requireString(
      row.requiredParentNodeExecutionId,
    ),
    resolvedParentTaskRunId: optionalString(row.resolvedParentTaskRunId),
    sourceHandle: optionalString(row.sourceHandle),
    targetHandle: optionalString(row.targetHandle),
    targetNodeId: requireString(row.targetNodeId),
  }));
}

async function loadOwnerCreditBalance(
  db: DbExecutor,
  ownerUserId: string,
): Promise<number> {
  const rows = rowsFromResult(
    await db.execute(sql`
      select credit_balance as "creditBalance"
      from "user"
      where id = ${ownerUserId}
      for update
    `),
  );
  const row = rows[0];
  if (!row) {
    throw new TypeError(`Missing owner user ${ownerUserId}`);
  }

  return requireNumber(row.creditBalance);
}

async function loadGeneratedOutputsForTaskRuns(
  db: DbExecutor,
  taskRunIds: readonly string[],
): Promise<
  ReadonlyMap<
    string,
    {
      readonly asset?: WorkflowAsset;
      readonly output: NonNullable<TaskRunGatekeeperTaskRun["output"]>;
    }
  >
> {
  const outputs = new Map<
    string,
    {
      readonly asset?: WorkflowAsset;
      readonly output: NonNullable<TaskRunGatekeeperTaskRun["output"]>;
    }
  >();
  for (const taskRunId of taskRunIds) {
    const rows = rowsFromResult(
      await db.execute(sql`
        select
          id as "assetId",
          kind,
          cdn_url as "cdnUrl",
          text_content as "text",
          mime_type as "contentType",
          file_name as "fileName",
          size_bytes as "sizeBytes",
          model,
          source,
          storage_key as "storagePath",
          external_uri as "externalUri",
          created_at as "createdAt"
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
    if (output.kind !== "INVALID_PRIMARY_GENERATED_ASSET_COUNT") {
      const row = rows[0];
      outputs.set(taskRunId, {
        output,
        ...(row && rows.length === 1 && output.kind === "cdn-asset"
          ? { asset: workflowAssetFromRow(row) }
          : {}),
      });
    }
  }

  return outputs;
}

async function persistGatekeeperResult(
  db: DbExecutor,
  input: {
    readonly initialDependencies: ReadonlyMap<
      string,
      TaskRunGatekeeperDependency
    >;
    readonly initialTaskRuns: ReadonlyMap<string, TaskRunGatekeeperTaskRun>;
    readonly ownerUserId: string;
    readonly resultState: TaskRunGatekeeperState;
    readonly taskRunRows: readonly GatekeeperTaskRunRow[];
  },
): Promise<ReadonlySet<string>> {
  const taskRunRowsById = new Map(
    input.taskRunRows.map((taskRun) => [taskRun.taskRunId, taskRun]),
  );
  const persistedTaskRunIds = new Set<string>();

  for (const taskRun of input.resultState.taskRuns) {
    const initial = input.initialTaskRuns.get(taskRun.id);
    if (!initial || isUnchangedTaskRun(initial, taskRun)) {
      continue;
    }

    const persisted = await updateGatekeeperTaskRun(db, initial, taskRun);
    if (!persisted) {
      continue;
    }
    persistedTaskRunIds.add(taskRun.id);

    if (initial.status !== "QUEUED" && taskRun.status === "QUEUED") {
      const row = requireTaskRunRow(taskRunRowsById, taskRun.id);
      await reserveTaskRunCredits(db, {
        amount: taskRun.reservedCredits ?? 0,
        ownerUserId: input.ownerUserId,
        taskRunId: taskRun.id,
        workflowId: row.workflowId,
      });
    }
  }

  for (const dependency of input.resultState.dependencies) {
    const initial = input.initialDependencies.get(
      taskDependencyKey(dependency),
    );
    if (
      !initial ||
      !persistedTaskRunIds.has(dependency.childTaskRunId) ||
      initial.resolvedParentTaskRunId === dependency.resolvedParentTaskRunId
    ) {
      continue;
    }

    await db.execute(sql`
      update task_dependencies
      set resolved_parent_task_run_id = ${dependency.resolvedParentTaskRunId},
        resolved_at = now()
      where child_task_run_id = ${dependency.childTaskRunId}
        and required_parent_node_execution_id = ${dependency.requiredParentNodeExecutionId}
        and required_parent_item_index = ${dependency.requiredParentItemIndex}
        and source_handle is not distinct from ${dependency.sourceHandle ?? null}
        and target_handle is not distinct from ${dependency.targetHandle ?? null}
        and resolved_parent_task_run_id is null
    `);
  }

  return persistedTaskRunIds;
}

async function updateGatekeeperTaskRun(
  db: DbExecutor,
  initial: TaskRunGatekeeperTaskRun,
  taskRun: TaskRunGatekeeperTaskRun,
): Promise<boolean> {
  const rows = rowsFromResult(
    await db.execute(sql`
    update task_runs
    set
      runtime_status = ${taskRun.status},
      reserved_credits = ${taskRun.reservedCredits ?? null},
      input_snapshot = ${inputSnapshotJson(taskRun.inputSnapshot ?? null)}::jsonb,
      failure_reason = ${taskRun.failureReason?.type ?? null},
      error = ${taskRun.failureReason ? failureReasonError(taskRun.failureReason) : null},
      queued_at = case when ${taskRun.status} = 'QUEUED' then now() else queued_at end,
      failed_at = case when ${taskRun.status} in ('FAILED', 'UPSTREAM_FAILED') then now() else failed_at end,
      updated_at = now()
    where id = ${taskRun.id}
      and runtime_status = ${initial.status}
    returning id
  `),
  );

  return rows.length > 0;
}

async function reserveTaskRunCredits(
  db: DbExecutor,
  input: {
    readonly amount: number;
    readonly ownerUserId: string;
    readonly taskRunId: string;
    readonly workflowId: string;
  },
): Promise<void> {
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
}

function inputSnapshotJson(
  snapshot: TaskRunInputSnapshot | null,
): string | null {
  return snapshot ? JSON.stringify(snapshot) : null;
}

function projectGatekeeperTaskRun(
  row: GatekeeperTaskRunRow,
): TaskRunGatekeeperTaskRun {
  return {
    attempt: row.attempt,
    estimatedCreditCost: row.estimatedCreditCost,
    failureReason: row.failureReason,
    id: row.taskRunId,
    inputSnapshot: row.inputSnapshot,
    itemIndex: row.itemIndex,
    nodeId: row.nodeId,
    nodeExecutionId: row.nodeExecutionId,
    asset: row.asset,
    output: row.output,
    reservedCredits: row.reservedCredits,
    status: row.status,
    targetNodeConfig: requireTaskRunInputSnapshot(row.inputSnapshot)
      .targetNodeConfig,
  };
}

function workflowAssetFromRow(row: QueryRow): WorkflowAsset {
  return {
    createdAt: requireDate(row.createdAt).toISOString(),
    externalUri: optionalString(row.externalUri),
    fileName: requireString(row.fileName),
    id: requireString(row.assetId),
    kind: requireAssetKind(row.kind),
    mimeType: requireString(row.contentType),
    model: optionalString(row.model),
    size: requireNumber(row.sizeBytes),
    source: requireAssetSource(row.source),
    storagePath: optionalString(row.storagePath),
    url: requireString(row.cdnUrl),
  };
}

function isUnchangedTaskRun(
  left: TaskRunGatekeeperTaskRun,
  right: TaskRunGatekeeperTaskRun,
): boolean {
  return (
    left.status === right.status &&
    left.reservedCredits === right.reservedCredits &&
    left.failureReason?.type === right.failureReason?.type &&
    JSON.stringify(left.inputSnapshot ?? null) ===
      JSON.stringify(right.inputSnapshot ?? null)
  );
}

function taskDependencyKey(dependency: TaskRunGatekeeperDependency): string {
  return [
    dependency.childTaskRunId,
    dependency.requiredParentNodeExecutionId,
    dependency.requiredParentItemIndex,
    dependency.sourceHandle ?? "",
    dependency.targetHandle ?? "",
  ].join(":");
}

function buildCreditReservationSourceKey(taskRunId: string): string {
  return `task_run:${taskRunId}:credit_reservation`;
}

function requireTaskRunRow(
  rowsById: ReadonlyMap<string, GatekeeperTaskRunRow>,
  taskRunId: string,
): GatekeeperTaskRunRow {
  const row = rowsById.get(taskRunId);
  if (!row) {
    throw new TypeError(`Missing Task Run row ${taskRunId}`);
  }

  return row;
}

function failureReasonError(reason: TaskRunFailureReason): string | null {
  if (reason.type === "INSUFFICIENT_CREDITS") {
    return null;
  }
  if (reason.type === "UPSTREAM_FAILED") {
    return reason.failedParentTaskRunId;
  }

  return reason.message;
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

function requireDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed;
    }
  }

  throw new TypeError("Expected database date value");
}

function requireAssetKind(value: unknown): WorkflowAsset["kind"] {
  if (value === "image" || value === "video" || value === "text") {
    return value;
  }

  throw new TypeError("Expected asset kind value");
}

function requireAssetSource(value: unknown): WorkflowAsset["source"] {
  if (value === "upload" || value === "generated") {
    return value;
  }

  throw new TypeError("Expected asset source value");
}

function requireTaskRunStatus(value: unknown): TaskRunStatus {
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

  throw new TypeError("Expected task run status database value");
}

function optionalTaskRunFailureReason(
  value: unknown,
  error: unknown,
): TaskRunFailureReason | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === "INSUFFICIENT_CREDITS") {
    return { type: "INSUFFICIENT_CREDITS" };
  }
  if (value === "PROVIDER_FAILED" || value === "EXECUTION_FAILED") {
    return {
      message: typeof error === "string" ? error : "Task Run failed",
      type: value,
    };
  }
  if (value === "UPSTREAM_FAILED") {
    return {
      failedParentTaskRunId: typeof error === "string" ? error : "unknown",
      type: "UPSTREAM_FAILED",
    };
  }

  throw new TypeError("Expected task run failure reason database value");
}

function requireTaskRunInputSnapshot(value: unknown): TaskRunInputSnapshot {
  if (!isTaskRunInputSnapshot(value)) {
    throw new TypeError("Expected task run input snapshot database value");
  }

  return value;
}

function optionalTaskRunInputSnapshot(
  value: unknown,
): TaskRunInputSnapshot | null {
  return value === null ? null : requireTaskRunInputSnapshot(value);
}
