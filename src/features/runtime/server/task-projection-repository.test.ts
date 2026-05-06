import { beforeAll, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { SqlClient } from "@effect/sql";
import { type Context, Effect } from "effect";
import { getTaskRunProjectionForWorkflow } from "~/features/runtime/server/task-projection-repository";
import { ServerTestRuntime } from "~/server/effect";
import { DatabaseService } from "~/server/services/database";

let database: Context.Tag.Service<typeof DatabaseService>;

describe.serial("getTaskRunProjectionForWorkflow", () => {
  beforeAll(async () => {
    database = await ServerTestRuntime.runPromise(DatabaseService);
  });

  beforeEach(async () => {
    await ServerTestRuntime.runPromise(
      database.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`delete from assets`;
          yield* sql`delete from task_runs`;
          yield* sql`delete from node_executions`;
          yield* sql`delete from workflows`;
          yield* sql`delete from "user"`;
          yield* seedWorkflow(sql);
        }),
      ),
    );
  });

  test("returns latest slot attempts with renderable generated outputs through Effect SQL", async () => {
    await ServerTestRuntime.runPromise(
      database.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* insertNodeExecution(sql, {
            id: "node-execution-source",
            nodeId: "source",
          });
          yield* insertTaskRun(sql, {
            attempt: 0,
            id: "source-item-0-attempt-0",
            nodeExecutionId: "node-execution-source",
            runtimeStatus: "APPROVED",
          });
          yield* insertGeneratedTextAsset(sql, {
            assetId: "stale-text-asset",
            taskRunId: "source-item-0-attempt-0",
            text: "stale text",
          });
          yield* insertTaskRun(sql, {
            attempt: 1,
            id: "source-item-0-attempt-1",
            nodeExecutionId: "node-execution-source",
            runtimeStatus: "PENDING_REVIEW",
          });
          yield* insertGeneratedTextAsset(sql, {
            assetId: "latest-text-asset",
            taskRunId: "source-item-0-attempt-1",
            text: "latest text",
          });
          yield* insertTaskRun(sql, {
            id: "source-item-1-attempt-0",
            itemIndex: 1,
            nodeExecutionId: "node-execution-source",
            runtimeStatus: "FAILED",
            failureReason: "PROVIDER_FAILED",
          });
        }),
      ),
    );

    const projection = await ServerTestRuntime.runPromise(
      getTaskRunProjectionForWorkflow({
        ownerUserId: "owner-user",
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(projection, [
      {
        attempt: 1,
        itemIndex: 0,
        nodeExecutionId: "node-execution-source",
        nodeId: "source",
        output: {
          assetId: "latest-text-asset",
          kind: "inline-text-asset",
          text: "latest text",
        },
        status: "PENDING_REVIEW",
        taskRunId: "source-item-0-attempt-1",
      },
      {
        attempt: 0,
        failureReason: "PROVIDER_FAILED",
        itemIndex: 1,
        nodeExecutionId: "node-execution-source",
        nodeId: "source",
        status: "FAILED",
        taskRunId: "source-item-1-attempt-0",
      },
    ]);
  });
});

function seedWorkflow(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql`insert into "user" (id, name, email, email_verified, credit_balance, created_at, updated_at) values ('owner-user', 'Owner', 'owner@example.com', false, 100, now(), now())`;
    yield* sql`insert into workflows (id, owner_user_id, name, document, created_at, updated_at) values ('workflow-id', 'owner-user', 'Workflow', '{"nodes":[],"edges":[],"version":9}'::jsonb, now(), now())`;
  });
}

function insertNodeExecution(
  sql: SqlClient.SqlClient,
  input: { readonly id: string; readonly nodeId: string },
) {
  return sql`
    insert into node_executions (id, workflow_id, owner_user_id, node_id, execution_id, status, output_count, target_reason, created_at, updated_at)
    values (${input.id}, 'workflow-id', 'owner-user', ${input.nodeId}, ${input.id}, 'pending', 1, 'node_run', now(), now())
  `;
}

function insertTaskRun(
  sql: SqlClient.SqlClient,
  input: {
    readonly attempt?: number;
    readonly failureReason?: string;
    readonly id: string;
    readonly itemIndex?: number;
    readonly nodeExecutionId: string;
    readonly runtimeStatus: string;
  },
) {
  const attempt = input.attempt ?? 0;
  const itemIndex = input.itemIndex ?? 0;
  return sql`
    insert into task_runs (id, node_execution_id, workflow_id, owner_user_id, node_id, output_index, version, item_index, attempt, execution_id, job_id, status, runtime_status, target_reason, failure_reason, credit_cost, queued_at, created_at, updated_at)
    select ${input.id}, node_executions.id, node_executions.workflow_id, node_executions.owner_user_id, node_executions.node_id, ${itemIndex}, ${attempt}, ${itemIndex}, ${attempt}, node_executions.id, ${`job-${input.id}`}, 'queued', ${input.runtimeStatus}, 'node_run', ${input.failureReason ?? null}, 0, now(), now(), now()
    from node_executions where node_executions.id = ${input.nodeExecutionId}
  `;
}

function insertGeneratedTextAsset(
  sql: SqlClient.SqlClient,
  input: {
    readonly assetId: string;
    readonly taskRunId: string;
    readonly text: string;
  },
) {
  return sql`
    insert into assets (id, owner_user_id, workflow_id, source, kind, task_run_id, storage_provider, text_content, mime_type, file_name, size_bytes, created_at)
    values (${input.assetId}, 'owner-user', 'workflow-id', 'generated', 'text', ${input.taskRunId}, 'inline', ${input.text}, 'text/plain', ${`${input.assetId}.txt`}, ${input.text.length}, now())
  `;
}
