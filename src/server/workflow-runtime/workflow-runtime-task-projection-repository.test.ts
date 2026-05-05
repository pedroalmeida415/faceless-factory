import { afterAll, beforeAll, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import { getTaskRunProjectionForWorkflow } from "~/server/workflow-runtime/workflow-runtime-task-projection-repository";

describe("getTaskRunProjectionForWorkflow", () => {
  let client: PGlite;
  let db: PgliteDatabase;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client);
    await setupProjectionTables(db);
  });

  beforeEach(async () => {
    await resetProjectionTables(db);
  });

  afterAll(async () => {
    await client.close();
  });

  test("returns the latest Attempt for each Node Execution item slot", async () => {
    await insertNodeExecution(db, {
      id: "node-execution-source",
      nodeId: "source",
    });
    await insertTaskRun(db, {
      attempt: 0,
      id: "source-item-0-attempt-0",
      nodeExecutionId: "node-execution-source",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      attempt: 1,
      id: "source-item-0-attempt-1",
      nodeExecutionId: "node-execution-source",
      runtimeStatus: "PENDING_REVIEW",
    });
    await insertTaskRun(db, {
      id: "source-item-1-attempt-0",
      itemIndex: 1,
      nodeExecutionId: "node-execution-source",
      runtimeStatus: "RUNNING",
    });

    const projection = await getTaskRunProjectionForWorkflow(db, {
      ownerUserId: "owner-user",
      workflowId: "workflow-id",
    });

    assert.deepEqual(projection, [
      {
        attempt: 1,
        itemIndex: 0,
        nodeExecutionId: "node-execution-source",
        nodeId: "source",
        status: "PENDING_REVIEW",
        taskRunId: "source-item-0-attempt-1",
      },
      {
        attempt: 0,
        itemIndex: 1,
        nodeExecutionId: "node-execution-source",
        nodeId: "source",
        status: "RUNNING",
        taskRunId: "source-item-1-attempt-0",
      },
    ]);
  });

  test("accepts bigint values returned as strings by postgres-js", async () => {
    const projection = await getTaskRunProjectionForWorkflow(
      {
        execute: async () => [
          {
            assetId: null,
            assetKind: null,
            attempt: "2",
            cdnUrl: null,
            contentType: null,
            failureReason: null,
            itemIndex: "3",
            nodeExecutionId: "node-execution-string-bigints",
            nodeId: "node-string-bigints",
            status: "APPROVED",
            taskRunId: "task-run-string-bigints",
            text: null,
          },
        ],
      },
      { ownerUserId: "owner-user", workflowId: "workflow-id" },
    );

    assert.deepEqual(projection, [
      {
        attempt: 2,
        itemIndex: 3,
        nodeExecutionId: "node-execution-string-bigints",
        nodeId: "node-string-bigints",
        status: "APPROVED",
        taskRunId: "task-run-string-bigints",
      },
    ]);
  });

  test("includes renderable output payloads for generated text and media Assets", async () => {
    await insertNodeExecution(db, {
      id: "node-execution-assets",
      nodeId: "asset-node",
    });
    await insertTaskRun(db, {
      id: "text-task-run",
      itemIndex: 0,
      nodeExecutionId: "node-execution-assets",
      nodeId: "asset-node",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "text-asset",
      taskRunId: "text-task-run",
      text: "Generated script",
    });
    await insertTaskRun(db, {
      id: "image-task-run",
      itemIndex: 1,
      nodeExecutionId: "node-execution-assets",
      nodeId: "asset-node",
      runtimeStatus: "PENDING_REVIEW",
    });
    await insertGeneratedMediaAsset(db, {
      assetId: "image-asset",
      cdnUrl: "https://cdn.example.com/image-asset.png",
      contentType: "image/png",
      taskRunId: "image-task-run",
    });

    const projection = await getTaskRunProjectionForWorkflow(db, {
      ownerUserId: "owner-user",
      workflowId: "workflow-id",
    });

    assert.deepEqual(projection, [
      {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-assets",
        nodeId: "asset-node",
        output: {
          assetId: "text-asset",
          kind: "inline-text-asset",
          text: "Generated script",
        },
        status: "APPROVED",
        taskRunId: "text-task-run",
      },
      {
        attempt: 0,
        itemIndex: 1,
        nodeExecutionId: "node-execution-assets",
        nodeId: "asset-node",
        output: {
          assetId: "image-asset",
          cdnUrl: "https://cdn.example.com/image-asset.png",
          contentType: "image/png",
          kind: "cdn-asset",
        },
        status: "PENDING_REVIEW",
        taskRunId: "image-task-run",
      },
    ]);
  });

  test("ignores stale older Attempt output and includes latest failure reason", async () => {
    await insertNodeExecution(db, {
      id: "node-execution-regenerated",
      nodeId: "regenerated-node",
    });
    await insertTaskRun(db, {
      attempt: 0,
      id: "stale-approved-task-run",
      nodeExecutionId: "node-execution-regenerated",
      nodeId: "regenerated-node",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "stale-text-asset",
      taskRunId: "stale-approved-task-run",
      text: "Do not render this older attempt",
    });
    await insertTaskRun(db, {
      attempt: 1,
      failureReason: "PROVIDER_FAILED",
      id: "latest-failed-task-run",
      nodeExecutionId: "node-execution-regenerated",
      nodeId: "regenerated-node",
      runtimeStatus: "FAILED",
    });

    const projection = await getTaskRunProjectionForWorkflow(db, {
      ownerUserId: "owner-user",
      workflowId: "workflow-id",
    });

    assert.deepEqual(projection, [
      {
        attempt: 1,
        failureReason: "PROVIDER_FAILED",
        itemIndex: 0,
        nodeExecutionId: "node-execution-regenerated",
        nodeId: "regenerated-node",
        status: "FAILED",
        taskRunId: "latest-failed-task-run",
      },
    ]);
  });
});

async function setupProjectionTables(db: PgliteDatabase) {
  await db.execute(sql`
    create type task_run_runtime_status as enum (
      'WAITING_UPSTREAM',
      'QUEUED',
      'RUNNING',
      'PENDING_REVIEW',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
      'FAILED',
      'UPSTREAM_FAILED'
    )
  `);
  await db.execute(sql`
    create type task_run_failure_reason as enum (
      'INSUFFICIENT_CREDITS',
      'PROVIDER_FAILED',
      'EXECUTION_FAILED',
      'UPSTREAM_FAILED'
    )
  `);
  await db.execute(sql`
    create table node_executions (
      id text primary key,
      workflow_id text not null,
      owner_user_id text not null,
      node_id text not null,
      created_at timestamp not null default now()
    )
  `);
  await db.execute(sql`
    create table task_runs (
      id text primary key,
      node_execution_id text not null,
      workflow_id text not null,
      owner_user_id text not null,
      node_id text not null,
      item_index bigint,
      attempt bigint,
      runtime_status task_run_runtime_status,
      failure_reason task_run_failure_reason
    )
  `);
  await db.execute(sql`
    create table assets (
      id text primary key,
      workflow_id text not null,
      owner_user_id text not null,
      source text not null,
      kind text not null,
      task_run_id text,
      cdn_url text,
      text_content text,
      mime_type text not null,
      deleted_at timestamp,
      created_at timestamp not null default now()
    )
  `);
}

async function resetProjectionTables(db: PgliteDatabase) {
  await db.execute(sql`
    truncate table assets, task_runs, node_executions
  `);
}

async function insertNodeExecution(
  db: PgliteDatabase,
  input: {
    readonly createdAt?: string;
    readonly id: string;
    readonly nodeId: string;
    readonly ownerUserId?: string;
    readonly workflowId?: string;
  },
) {
  await db.execute(sql`
    insert into node_executions (
      id,
      workflow_id,
      owner_user_id,
      node_id,
      created_at
    ) values (
      ${input.id},
      ${input.workflowId ?? "workflow-id"},
      ${input.ownerUserId ?? "owner-user"},
      ${input.nodeId},
      ${input.createdAt ?? "2026-01-01T00:00:00.000Z"}
    )
  `);
}

async function insertTaskRun(
  db: PgliteDatabase,
  input: {
    readonly attempt?: number;
    readonly failureReason?: "INSUFFICIENT_CREDITS" | "PROVIDER_FAILED";
    readonly id: string;
    readonly itemIndex?: number;
    readonly nodeExecutionId: string;
    readonly nodeId?: string;
    readonly ownerUserId?: string;
    readonly runtimeStatus:
      | "APPROVED"
      | "FAILED"
      | "PENDING_REVIEW"
      | "RUNNING";
    readonly workflowId?: string;
  },
) {
  await db.execute(sql`
    insert into task_runs (
      id,
      node_execution_id,
      workflow_id,
      owner_user_id,
      node_id,
      item_index,
      attempt,
      runtime_status,
      failure_reason
    ) values (
      ${input.id},
      ${input.nodeExecutionId},
      ${input.workflowId ?? "workflow-id"},
      ${input.ownerUserId ?? "owner-user"},
      ${input.nodeId ?? "source"},
      ${input.itemIndex ?? 0},
      ${input.attempt ?? 0},
      ${input.runtimeStatus},
      ${input.failureReason ?? null}
    )
  `);
}

async function insertGeneratedTextAsset(
  db: PgliteDatabase,
  input: {
    readonly assetId: string;
    readonly taskRunId: string;
    readonly text: string;
  },
) {
  await db.execute(sql`
    insert into assets (
      id,
      workflow_id,
      owner_user_id,
      source,
      kind,
      task_run_id,
      text_content,
      mime_type
    ) values (
      ${input.assetId},
      'workflow-id',
      'owner-user',
      'generated',
      'text',
      ${input.taskRunId},
      ${input.text},
      'text/plain'
    )
  `);
}

async function insertGeneratedMediaAsset(
  db: PgliteDatabase,
  input: {
    readonly assetId: string;
    readonly cdnUrl: string;
    readonly contentType: string;
    readonly taskRunId: string;
  },
) {
  await db.execute(sql`
    insert into assets (
      id,
      workflow_id,
      owner_user_id,
      source,
      kind,
      task_run_id,
      cdn_url,
      mime_type
    ) values (
      ${input.assetId},
      'workflow-id',
      'owner-user',
      'generated',
      'image',
      ${input.taskRunId},
      ${input.cdnUrl},
      ${input.contentType}
    )
  `);
}
