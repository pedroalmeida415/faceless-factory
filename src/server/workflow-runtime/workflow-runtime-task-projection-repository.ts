import { type SQL, sql } from "drizzle-orm";

import {
  type GeneratedAsset,
  projectGeneratedAssetToTaskOutput,
} from "~/lib/workflow-runtime/assets/generated-asset-projection";
import type {
  RenderableTaskOutput,
  TaskStatusEventFailureReason,
  TaskStatusEventStatus,
} from "~/lib/workflow-runtime/runtime/task-status-events";

type DbLike = {
  readonly execute: (query: SQL) => Promise<unknown>;
};

type QueryRow = Record<string, unknown>;

export type TaskRunProjectionSlot = {
  readonly attempt: number;
  readonly failureReason?: TaskStatusEventFailureReason;
  readonly itemIndex: number;
  readonly nodeExecutionId: string;
  readonly nodeId: string;
  readonly output?: RenderableTaskOutput;
  readonly status: TaskStatusEventStatus;
  readonly taskRunId: string;
};

export async function getTaskRunProjectionForWorkflow(
  db: DbLike,
  params: {
    readonly ownerUserId: string;
    readonly workflowId: string;
  },
): Promise<readonly TaskRunProjectionSlot[]> {
  const rows = rowsFromResult(
    await db.execute(sql`
      with latest_node_executions as (
        select distinct on (node_id)
          id
        from node_executions
        where workflow_id = ${params.workflowId}
          and owner_user_id = ${params.ownerUserId}
        order by node_id asc, created_at desc, id desc
      ), latest_task_runs as (
        select distinct on (task_runs.node_execution_id, task_runs.item_index)
          task_runs.id as "taskRunId",
          task_runs.node_execution_id as "nodeExecutionId",
          task_runs.node_id as "nodeId",
          task_runs.item_index as "itemIndex",
          task_runs.attempt,
          task_runs.runtime_status as status,
          task_runs.failure_reason as "failureReason"
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
      )
      select
        latest_task_runs."taskRunId",
        latest_task_runs."nodeExecutionId",
        latest_task_runs."nodeId",
        latest_task_runs."itemIndex",
        latest_task_runs.attempt,
        latest_task_runs.status,
        latest_task_runs."failureReason",
        assets.id as "assetId",
        assets.kind as "assetKind",
        assets.cdn_url as "cdnUrl",
        assets.text_content as text,
        assets.mime_type as "contentType"
      from latest_task_runs
      left join assets
        on assets.task_run_id = latest_task_runs."taskRunId"
        and assets.source = 'generated'
        and assets.deleted_at is null
      order by
        latest_task_runs."nodeExecutionId" asc,
        latest_task_runs."itemIndex" asc,
        assets.created_at asc,
        assets.id asc
    `),
  );

  const slotByKey = new Map<string, TaskRunProjectionSlot>();
  const assetsByTaskRunId = new Map<string, GeneratedAsset[]>();

  for (const row of rows) {
    const taskRunId = requireString(row.taskRunId);
    const slotKey = `${requireString(row.nodeExecutionId)}:${requireNumber(row.itemIndex)}`;
    if (!slotByKey.has(slotKey)) {
      const failureReason = optionalTaskStatusFailureReason(row.failureReason);
      slotByKey.set(slotKey, {
        attempt: requireNumber(row.attempt),
        ...(failureReason ? { failureReason } : {}),
        itemIndex: requireNumber(row.itemIndex),
        nodeExecutionId: requireString(row.nodeExecutionId),
        nodeId: requireString(row.nodeId),
        status: requireTaskStatus(row.status),
        taskRunId,
      });
      assetsByTaskRunId.set(taskRunId, []);
    }

    const asset = optionalGeneratedAssetFromRow(row);
    if (asset) {
      assetsByTaskRunId.get(taskRunId)?.push(asset);
    }
  }

  return [...slotByKey.values()].map((slot) => {
    const output = projectGeneratedAssetToTaskOutput(
      assetsByTaskRunId.get(slot.taskRunId) ?? [],
    );

    return output.kind === "INVALID_PRIMARY_GENERATED_ASSET_COUNT"
      ? slot
      : { ...slot, output };
  });
}

function optionalGeneratedAssetFromRow(row: QueryRow): GeneratedAsset | null {
  const assetId = optionalString(row.assetId);
  if (!assetId) {
    return null;
  }

  const kind = row.assetKind;
  if (kind === "text") {
    return { assetId, kind, text: requireString(row.text) };
  }
  if (kind === "image" || kind === "video") {
    return {
      assetId,
      cdnUrl: requireString(row.cdnUrl),
      contentType: requireString(row.contentType),
      kind,
    };
  }

  return null;
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
  return value === null ? null : requireString(value);
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError("Expected integer database number value");
  }

  return value;
}

function requireTaskStatus(value: unknown): TaskStatusEventStatus {
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

function optionalTaskStatusFailureReason(
  value: unknown,
): TaskStatusEventFailureReason | undefined {
  if (value === null) {
    return undefined;
  }
  if (
    value === "INSUFFICIENT_CREDITS" ||
    value === "PROVIDER_FAILED" ||
    value === "EXECUTION_FAILED" ||
    value === "UPSTREAM_FAILED"
  ) {
    return value;
  }

  throw new TypeError("Expected Task Run failure reason database value");
}
