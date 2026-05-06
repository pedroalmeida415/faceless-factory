import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { SqlClient } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import * as PgClient from "@effect/sql-pg/PgClient";
import type { DrizzleConfig } from "drizzle-orm";
import { Effect, Layer, Redacted } from "effect";

import * as schema from "~/server/db/schema";
import { getPlanningStateForWorkflow } from "~/server/workflow-runtime/workflow-runtime-planning-state-repository";

const TestPgClientLive = PgClient.layer({
  database: "faceless-factory",
  host: "localhost",
  password: Redacted.make("lHOqxPGUlf02HNI8"),
  port: 5432,
  username: "postgres",
});
const TestPgLive = Layer.mergeAll(
  TestPgClientLive,
  PgDrizzle.layerWithConfig({ schema } as unknown as DrizzleConfig).pipe(
    Layer.provide(TestPgClientLive),
  ),
);

function runEffect<A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | PgDrizzle.PgDrizzle>,
) {
  return Effect.runPromise(effect.pipe(Effect.provide(TestPgLive)));
}

describe("getPlanningStateForWorkflow", () => {
  beforeEach(async () => {
    await runEffect(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`delete from task_runs`;
        yield* sql`delete from node_executions`;
        yield* sql`delete from workflows`;
        yield* sql`delete from "user"`;
        yield* seedWorkflow(sql);
      }),
    );
  });

  test("returns latest Node Executions and latest slot Attempts for the owner workflow through Effect SQL", async () => {
    await runEffect(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertNodeExecution(sql, {
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "source-old-execution",
          nodeId: "source",
        });
        yield* insertNodeExecution(sql, {
          createdAt: "2026-01-02T00:00:00.000Z",
          id: "source-latest-execution",
          nodeId: "source",
        });
        yield* insertNodeExecution(sql, {
          createdAt: "2026-01-03T00:00:00.000Z",
          id: "child-latest-execution",
          nodeId: "child",
        });
        yield* insertNodeExecution(sql, {
          id: "other-owner-execution",
          nodeId: "source",
          ownerUserId: "other-owner",
        });
        yield* insertTaskRun(sql, {
          attempt: 0,
          id: "source-stale-attempt",
          nodeExecutionId: "source-latest-execution",
          runtimeStatus: "APPROVED",
        });
        yield* insertTaskRun(sql, {
          attempt: 1,
          id: "source-active-attempt",
          nodeExecutionId: "source-latest-execution",
          runtimeStatus: "PENDING_REVIEW",
        });
        yield* insertTaskRun(sql, {
          attempt: 0,
          id: "source-old-execution-task",
          nodeExecutionId: "source-old-execution",
          runtimeStatus: "APPROVED",
        });
        yield* insertTaskRun(sql, {
          id: "legacy-task-without-runtime-status",
          nodeExecutionId: "child-latest-execution",
          runtimeStatus: null,
        });
        yield* insertTaskRun(sql, {
          id: "child-task",
          itemIndex: 1,
          nodeExecutionId: "child-latest-execution",
          runtimeStatus: "FAILED",
        });
      }),
    );

    const state = await runEffect(
      getPlanningStateForWorkflow({
        ownerUserId: "owner-user",
        workflowId: "workflow-id",
      }),
    );

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
});

function seedWorkflow(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql`insert into "user" (id, name, email, email_verified, credit_balance, created_at, updated_at) values ('owner-user', 'Owner', 'owner@example.com', false, 100, now(), now())`;
    yield* sql`insert into "user" (id, name, email, email_verified, credit_balance, created_at, updated_at) values ('other-owner', 'Other', 'other@example.com', false, 100, now(), now())`;
    yield* sql`insert into workflows (id, owner_user_id, name, document, created_at, updated_at) values ('workflow-id', 'owner-user', 'Workflow', '{"nodes":[],"edges":[],"version":9}'::jsonb, now(), now())`;
    yield* sql`insert into workflows (id, owner_user_id, name, document, created_at, updated_at) values ('other-workflow-id', 'other-owner', 'Other Workflow', '{"nodes":[],"edges":[],"version":9}'::jsonb, now(), now())`;
  });
}

function insertNodeExecution(
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
    insert into node_executions (id, workflow_id, owner_user_id, node_id, execution_id, status, output_count, target_reason, created_at, updated_at)
    values (${input.id}, ${ownerUserId === "owner-user" ? "workflow-id" : "other-workflow-id"}, ${ownerUserId}, ${input.nodeId}, ${input.id}, 'pending', 1, 'node_run', ${input.createdAt ?? new Date().toISOString()}, now())
  `;
}

function insertTaskRun(
  sql: SqlClient.SqlClient,
  input: {
    readonly attempt?: number;
    readonly id: string;
    readonly itemIndex?: number;
    readonly nodeExecutionId: string;
    readonly runtimeStatus: string | null;
  },
) {
  const attempt = input.attempt ?? 0;
  const itemIndex = input.itemIndex ?? 0;
  return sql`
    insert into task_runs (id, node_execution_id, workflow_id, owner_user_id, node_id, output_index, version, item_index, attempt, execution_id, job_id, status, runtime_status, target_reason, credit_cost, queued_at, created_at, updated_at)
    select ${input.id}, node_executions.id, node_executions.workflow_id, node_executions.owner_user_id, node_executions.node_id, ${itemIndex}, ${attempt}, ${itemIndex}, ${attempt}, node_executions.id, ${`job-${input.id}`}, 'queued', ${input.runtimeStatus}, 'node_run', 0, now(), now(), now()
    from node_executions where node_executions.id = ${input.nodeExecutionId}
  `;
}
