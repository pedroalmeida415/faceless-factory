import { beforeAll, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { SqlClient } from "@effect/sql";
import { type Context, Effect } from "effect";
import { getPlanningStateForWorkflow } from "~/features/runtime/server/planning-state-repository";
import { ServerTestRuntime } from "~/server/effect";
import { DatabaseService } from "~/server/services/database";

let database: Context.Tag.Service<typeof DatabaseService>;

describe.serial("getPlanningStateForWorkflow", () => {
  beforeAll(async () => {
    database = await ServerTestRuntime.runPromise(DatabaseService);
  });

  beforeEach(async () => {
    await ServerTestRuntime.runPromise(
      database.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`delete from tasks`;
          yield* sql`delete from node_runs`;
          yield* sql`delete from workflows`;
          yield* sql`delete from "user"`;
          yield* seedWorkflow(sql);
        }),
      ),
    );
  });

  test("returns latest Node Runs and latest Branch Tasks for the owner workflow through Effect SQL", async () => {
    await ServerTestRuntime.runPromise(
      database.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* insertNodeRun(sql, {
            createdAt: "2026-01-01T00:00:00.000Z",
            id: "source-old-execution",
            nodeId: "source",
          });
          yield* insertNodeRun(sql, {
            createdAt: "2026-01-02T00:00:00.000Z",
            id: "source-latest-execution",
            nodeId: "source",
          });
          yield* insertNodeRun(sql, {
            createdAt: "2026-01-03T00:00:00.000Z",
            id: "child-latest-execution",
            nodeId: "child",
          });
          yield* insertNodeRun(sql, {
            id: "other-owner-execution",
            nodeId: "source",
            ownerUserId: "other-owner",
          });
          yield* insertTask(sql, {
            createdAt: "2026-01-02T00:00:00.000Z",
            id: "source-stale-task",
            nodeRunId: "source-latest-execution",
            runtimeStatus: "APPROVED",
          });
          yield* insertTask(sql, {
            createdAt: "2026-01-02T00:00:01.000Z",
            id: "source-active-task",
            nodeRunId: "source-latest-execution",
            runtimeStatus: "PENDING_REVIEW",
          });
          yield* insertTask(sql, {
            id: "source-old-execution-task",
            nodeRunId: "source-old-execution",
            runtimeStatus: "APPROVED",
          });
          yield* insertTask(sql, {
            id: "legacy-task-without-runtime-status",
            nodeRunId: "child-latest-execution",
            runtimeStatus: null,
          });
          yield* insertTask(sql, {
            id: "child-task",
            branchIndex: 1,
            nodeRunId: "child-latest-execution",
            runtimeStatus: "FAILED",
          });
        }),
      ),
    );

    const state = await ServerTestRuntime.runPromise(
      getPlanningStateForWorkflow({
        ownerUserId: "owner-user",
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(state, {
      latestNodeRuns: [
        { id: "child-latest-execution", nodeId: "child" },
        { id: "source-latest-execution", nodeId: "source" },
      ],
      latestTasks: [
        {
          creditCost: 0,
          id: "child-task",
          branchIndex: 1,
          nodeRunId: "child-latest-execution",
          nodeId: "child",
          status: "FAILED",
        },
        {
          creditCost: 0,
          id: "source-active-task",
          branchIndex: 0,
          nodeRunId: "source-latest-execution",
          nodeId: "source",
          status: "PENDING_REVIEW",
        },
      ],
    });
  });
});

function seedWorkflow(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql`insert into "user" (id, name, email, email_verified, credit_balance, created_at, updated_at) values ('owner-user', 'Owner', 'owner@example.com', false, 100, now(), now())`;
    yield* sql`insert into "user" (id, name, email, email_verified, credit_balance, created_at, updated_at) values ('other-owner', 'Other', 'other@example.com', false, 100, now(), now())`;
    yield* sql`insert into workflows (id, owner_user_id, name, document, created_at, updated_at) values ('workflow-id', 'owner-user', 'Workflow', '{"nodes":[],"edges":[],"version":9}'::jsonb, now(), now())`;
    yield* sql`insert into workflows (id, owner_user_id, name, document, created_at, updated_at) values ('other-workflow-id', 'other-owner', 'Other Workflow', '{"nodes":[],"edges":[],"version":9}'::jsonb, now(), now())`;
  });
}

function insertNodeRun(
  sql: SqlClient.SqlClient,
  input: {
    readonly createdAt?: string;
    readonly id: string;
    readonly nodeId: string;
    readonly ownerUserId?: string;
  },
) {
  const ownerUserId = input.ownerUserId ?? "owner-user";
  return sql`
    insert into node_runs (id, workflow_id, owner_user_id, node_id, execution_id, status, output_count, target_reason, created_at, updated_at)
    values (${input.id}, ${ownerUserId === "owner-user" ? "workflow-id" : "other-workflow-id"}, ${ownerUserId}, ${input.nodeId}, ${input.id}, 'pending', 1, 'node_run', ${input.createdAt ?? new Date().toISOString()}, now())
  `;
}

function insertTask(
  sql: SqlClient.SqlClient,
  input: {
    readonly createdAt?: string;
    readonly id: string;
    readonly branchIndex?: number;
    readonly nodeRunId: string;
    readonly runtimeStatus: string | null;
  },
) {
  const branchIndex = input.branchIndex ?? 0;
  return sql`
    insert into tasks (id, node_run_id, workflow_id, owner_user_id, node_id, output_index, version, branch_index, execution_id, job_id, status, runtime_status, target_reason, credit_cost, queued_at, created_at, updated_at)
    select ${input.id}, node_runs.id, node_runs.workflow_id, node_runs.owner_user_id, node_runs.node_id, ${branchIndex}, 0, ${branchIndex}, node_runs.id, ${`job-${input.id}`}, 'queued', ${input.runtimeStatus}, 'node_run', 0, now(), ${input.createdAt ?? new Date().toISOString()}, now()
    from node_runs where node_runs.id = ${input.nodeRunId}
  `;
}
