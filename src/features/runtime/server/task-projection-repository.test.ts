import { beforeAll, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { SqlClient } from "@effect/sql";
import { type Context, Effect } from "effect";
import { getTaskProjectionForWorkflow } from "~/features/runtime/server/task-projection-repository";
import { ServerTestRuntime } from "~/server/effect";
import { DatabaseService } from "~/server/services/database";

let database: Context.Tag.Service<typeof DatabaseService>;

describe.serial("getTaskProjectionForWorkflow", () => {
  beforeAll(async () => {
    database = await ServerTestRuntime.runPromise(DatabaseService);
  });

  beforeEach(async () => {
    await ServerTestRuntime.runPromise(
      database.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`delete from assets`;
          yield* sql`delete from tasks`;
          yield* sql`delete from node_runs`;
          yield* sql`delete from workflows`;
          yield* sql`delete from "user"`;
          yield* seedWorkflow(sql);
        }),
      ),
    );
  });

  test("returns latest Branch tasks with renderable generated outputs through Effect SQL", async () => {
    await ServerTestRuntime.runPromise(
      database.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* insertNodeRun(sql, {
            id: "node-execution-source",
            nodeId: "source",
          });
          yield* insertTask(sql, {
            id: "source-branch-0-stale-task",
            nodeRunId: "node-execution-source",
            runtimeStatus: "APPROVED",
          });
          yield* insertGeneratedTextAsset(sql, {
            assetId: "stale-text-asset",
            taskId: "source-branch-0-stale-task",
            text: "stale text",
          });
          yield* insertTask(sql, {
            id: "source-branch-0-latest-task",
            nodeRunId: "node-execution-source",
            runtimeStatus: "PENDING_REVIEW",
          });
          yield* insertGeneratedTextAsset(sql, {
            assetId: "latest-text-asset",
            taskId: "source-branch-0-latest-task",
            text: "latest text",
          });
          yield* insertTask(sql, {
            id: "source-branch-1-failed-task",
            branchIndex: 1,
            nodeRunId: "node-execution-source",
            runtimeStatus: "FAILED",
            failureReason: "PROVIDER_FAILED",
          });
        }),
      ),
    );

    const projection = await ServerTestRuntime.runPromise(
      getTaskProjectionForWorkflow({
        ownerUserId: "owner-user",
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(projection, [
      {
        branchIndex: 0,
        nodeRunId: "node-execution-source",
        nodeId: "source",
        output: {
          assetId: "latest-text-asset",
          kind: "inline-text-asset",
          text: "latest text",
        },
        status: "PENDING_REVIEW",
        taskId: "source-branch-0-latest-task",
      },
      {
        failureReason: "PROVIDER_FAILED",
        branchIndex: 1,
        nodeRunId: "node-execution-source",
        nodeId: "source",
        status: "FAILED",
        taskId: "source-branch-1-failed-task",
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

function insertNodeRun(
  sql: SqlClient.SqlClient,
  input: { readonly id: string; readonly nodeId: string },
) {
  return sql`
    insert into node_runs (id, workflow_id, owner_user_id, node_id, execution_id, status, output_count, target_reason, created_at, updated_at)
    values (${input.id}, 'workflow-id', 'owner-user', ${input.nodeId}, ${input.id}, 'pending', 1, 'node_run', now(), now())
  `;
}

function insertTask(
  sql: SqlClient.SqlClient,
  input: {
    readonly failureReason?: string;
    readonly id: string;
    readonly branchIndex?: number;
    readonly nodeRunId: string;
    readonly runtimeStatus: string;
  },
) {
  const branchIndex = input.branchIndex ?? 0;
  return sql`
    insert into tasks (id, node_run_id, workflow_id, owner_user_id, node_id, output_index, version, branch_index, execution_id, job_id, status, runtime_status, target_reason, failure_reason, credit_cost, queued_at, created_at, updated_at)
    select ${input.id}, node_runs.id, node_runs.workflow_id, node_runs.owner_user_id, node_runs.node_id, ${branchIndex}, 0, ${branchIndex}, node_runs.id, ${`job-${input.id}`}, 'queued', ${input.runtimeStatus}, 'node_run', ${input.failureReason ?? null}, 0, now(), now(), now()
    from node_runs where node_runs.id = ${input.nodeRunId}
  `;
}

function insertGeneratedTextAsset(
  sql: SqlClient.SqlClient,
  input: {
    readonly assetId: string;
    readonly taskId: string;
    readonly text: string;
  },
) {
  return sql`
    insert into assets (id, owner_user_id, workflow_id, source, kind, task_id, storage_provider, text_content, mime_type, file_name, size_bytes, created_at)
    values (${input.assetId}, 'owner-user', 'workflow-id', 'generated', 'text', ${input.taskId}, 'inline', ${input.text}, 'text/plain', ${`${input.assetId}.txt`}, ${input.text.length}, now())
  `;
}
