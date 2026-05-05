import { afterAll, beforeAll, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import { getPlanningStateForWorkflow } from "~/server/workflow-runtime/workflow-runtime-planning-state-repository";

describe("getPlanningStateForWorkflow", () => {
  let client: PGlite;
  let db: PgliteDatabase;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client);
    await setupPlanningStateTables(db);
  });

  beforeEach(async () => {
    await resetPlanningStateTables(db);
  });

  afterAll(async () => {
    await client.close();
  });

  test("returns latest Node Executions and latest slot Attempts for the owner workflow", async () => {
    await insertNodeExecution(db, {
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "source-old-execution",
      nodeId: "source",
    });
    await insertNodeExecution(db, {
      createdAt: "2026-01-02T00:00:00.000Z",
      id: "source-latest-execution",
      nodeId: "source",
    });
    await insertNodeExecution(db, {
      createdAt: "2026-01-03T00:00:00.000Z",
      id: "child-latest-execution",
      nodeId: "child",
    });
    await insertNodeExecution(db, {
      id: "other-owner-execution",
      nodeId: "source",
      ownerUserId: "other-owner",
    });
    await insertTaskRun(db, {
      attempt: 0,
      id: "source-stale-attempt",
      nodeExecutionId: "source-latest-execution",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      attempt: 1,
      id: "source-active-attempt",
      nodeExecutionId: "source-latest-execution",
      runtimeStatus: "PENDING_REVIEW",
    });
    await insertTaskRun(db, {
      attempt: 0,
      id: "source-old-execution-task",
      nodeExecutionId: "source-old-execution",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      id: "legacy-task-without-runtime-status",
      nodeExecutionId: "child-latest-execution",
      runtimeStatus: null,
    });
    await insertTaskRun(db, {
      id: "child-task",
      itemIndex: 1,
      nodeExecutionId: "child-latest-execution",
      runtimeStatus: "FAILED",
    });

    const state = await getPlanningStateForWorkflow(db, {
      ownerUserId: "owner-user",
      workflowId: "workflow-id",
    });

    assert.deepEqual(state, {
      latestNodeExecutions: [
        { id: "child-latest-execution", nodeId: "child" },
        { id: "source-latest-execution", nodeId: "source" },
      ],
      latestTaskRuns: [
        {
          attempt: 0,
          creditCost: 0,
          id: "child-task",
          itemIndex: 1,
          nodeExecutionId: "child-latest-execution",
          nodeId: "child",
          status: "FAILED",
        },
        {
          attempt: 1,
          creditCost: 0,
          id: "source-active-attempt",
          itemIndex: 0,
          nodeExecutionId: "source-latest-execution",
          nodeId: "source",
          status: "PENDING_REVIEW",
        },
      ],
    });
  });

  test("accepts bigint values returned as strings by postgres-js", async () => {
    let callIndex = 0;
    const state = await getPlanningStateForWorkflow(
      {
        execute: async () => {
          callIndex += 1;
          return callIndex === 1
            ? [{ id: "node-execution", nodeId: "node" }]
            : [
                {
                  attempt: "4",
                  creditCost: "11",
                  id: "task-run",
                  itemIndex: "2",
                  nodeExecutionId: "node-execution",
                  nodeId: "node",
                  status: "APPROVED",
                },
              ];
        },
      },
      { ownerUserId: "owner-user", workflowId: "workflow-id" },
    );

    assert.deepEqual(state, {
      latestNodeExecutions: [{ id: "node-execution", nodeId: "node" }],
      latestTaskRuns: [
        {
          attempt: 4,
          creditCost: 11,
          id: "task-run",
          itemIndex: 2,
          nodeExecutionId: "node-execution",
          nodeId: "node",
          status: "APPROVED",
        },
      ],
    });
  });
});

async function setupPlanningStateTables(db: PgliteDatabase) {
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
      estimated_credit_cost bigint,
      runtime_status task_run_runtime_status
    )
  `);
}

async function resetPlanningStateTables(db: PgliteDatabase) {
  await db.execute(sql`
    truncate table task_runs, node_executions
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
    readonly id: string;
    readonly itemIndex?: number;
    readonly nodeExecutionId: string;
    readonly nodeId?: string;
    readonly ownerUserId?: string;
    readonly runtimeStatus: "APPROVED" | "FAILED" | "PENDING_REVIEW" | null;
    readonly creditCost?: number;
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
      estimated_credit_cost,
      runtime_status
    ) values (
      ${input.id},
      ${input.nodeExecutionId},
      ${input.workflowId ?? "workflow-id"},
      ${input.ownerUserId ?? "owner-user"},
      ${input.nodeId ?? input.nodeExecutionId.replace(/-(old|latest)-execution$/, "")},
      ${input.itemIndex ?? 0},
      ${input.attempt ?? 0},
      ${input.creditCost ?? 0},
      ${input.runtimeStatus}
    )
  `);
}
