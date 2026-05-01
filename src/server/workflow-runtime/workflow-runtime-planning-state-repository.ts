import { type SQL, sql } from "drizzle-orm";

import type {
  ExistingNodeExecution,
  ExistingTaskRun,
} from "~/lib/workflow-runtime/planning/workflow-run-planner";

type DbLike = {
  readonly execute: (query: SQL) => Promise<unknown>;
};

type QueryRow = Record<string, unknown>;

export type WorkflowRuntimePlanningState = {
  readonly latestNodeExecutions: readonly ExistingNodeExecution[];
  readonly latestTaskRuns: readonly ExistingTaskRun[];
};

export async function getPlanningStateForWorkflow(
  db: DbLike,
  params: {
    readonly ownerUserId: string;
    readonly workflowId: string;
  },
): Promise<WorkflowRuntimePlanningState> {
  const latestNodeExecutions = rowsFromResult(
    await db.execute(sql`
      select distinct on (node_id)
        id,
        node_id as "nodeId"
      from node_executions
      where workflow_id = ${params.workflowId}
        and owner_user_id = ${params.ownerUserId}
      order by node_id asc, created_at desc, id desc
    `),
  ).map((row) => ({
    id: requireString(row.id),
    nodeId: requireString(row.nodeId),
  }));

  if (latestNodeExecutions.length === 0) {
    return { latestNodeExecutions, latestTaskRuns: [] };
  }

  const latestTaskRuns = rowsFromResult(
    await db.execute(sql`
      with latest_node_executions as (
        select distinct on (node_id)
          id
        from node_executions
        where workflow_id = ${params.workflowId}
          and owner_user_id = ${params.ownerUserId}
        order by node_id asc, created_at desc, id desc
      )
      select distinct on (task_runs.node_execution_id, task_runs.item_index)
        task_runs.id,
        task_runs.node_execution_id as "nodeExecutionId",
        task_runs.item_index as "itemIndex",
        task_runs.attempt,
        task_runs.runtime_status as status
      from task_runs
      inner join latest_node_executions
        on latest_node_executions.id = task_runs.node_execution_id
      where task_runs.workflow_id = ${params.workflowId}
        and task_runs.owner_user_id = ${params.ownerUserId}
        and task_runs.runtime_status is not null
        and task_runs.item_index is not null
        and task_runs.attempt is not null
      order by
        task_runs.node_execution_id asc,
        task_runs.item_index asc,
        task_runs.attempt desc,
        task_runs.id desc
    `),
  ).map((row) => ({
    attempt: requireNumber(row.attempt),
    id: requireString(row.id),
    itemIndex: requireNumber(row.itemIndex),
    nodeExecutionId: requireString(row.nodeExecutionId),
    status: requireTaskRunStatus(row.status),
  }));

  return { latestNodeExecutions, latestTaskRuns };
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

function requireTaskRunStatus(value: unknown): ExistingTaskRun["status"] {
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

  throw new TypeError("Expected Task Run runtime status database value");
}
