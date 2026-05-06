import { afterAll, beforeAll, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { SqlClient } from "@effect/sql";
import { type Context, Effect } from "effect";
import type { TaskRunStatus } from "~/features/runtime/domain/task-run-state";
import type { TaskRunInputSnapshot } from "~/features/runtime/execution/task-run-input-snapshot";
import type { WorkflowRunPlan } from "~/features/runtime/planning/workflow-run-planner";
import { createRuntimeRepository } from "~/features/runtime/server/repository";
import { createWorkflowNode } from "~/features/workflow/document";
import { ServerTestRuntime } from "~/server/effect";
import { DatabaseService } from "~/server/services/database";

let database: Context.Tag.Service<typeof DatabaseService>;

async function resetEffectRuntimeTables() {
  await ServerTestRuntime.runPromise(
    database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`delete from task_dependencies`;
        yield* sql`delete from assets`;
        yield* sql`delete from credit_ledger_entries`;
        yield* sql`delete from task_runs`;
        yield* sql`delete from node_executions`;
        yield* sql`delete from workflows`;
        yield* sql`delete from "user"`;
      }),
    ),
  );
}

async function insertEffectTaskRun(input: {
  readonly attempt?: number;
  readonly creditCost?: number;
  readonly id: string;
  readonly inputSnapshot?: TaskRunInputSnapshot | null;
  readonly itemIndex?: number;
  readonly nodeExecutionId?: string;
  readonly runtimeStatus: TaskRunStatus;
}) {
  await ServerTestRuntime.runPromise(
    database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const attempt = input.attempt ?? 0;
        const itemIndex = input.itemIndex ?? 0;
        const nodeExecutionId =
          input.nodeExecutionId ?? `node-execution-${input.id}`;
        yield* seedEffectWorkflowSql(sql);
        yield* sql`
        insert into node_executions (
          id,
          workflow_id,
          owner_user_id,
          node_id,
          execution_id,
          status,
          output_count,
          target_reason,
          created_at,
          updated_at
        ) values (
          ${nodeExecutionId},
          'workflow-id',
          'owner-user',
          'node-id',
          ${nodeExecutionId},
          'pending',
          1,
          'node_run',
          now(),
          now()
        ) on conflict (id) do nothing
      `;
        yield* sql`
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
          credit_cost,
          input_snapshot,
          queued_at,
          created_at,
          updated_at
        ) values (
          ${input.id},
          ${nodeExecutionId},
          'workflow-id',
          'owner-user',
          'node-id',
          0,
          ${attempt},
          ${itemIndex},
          ${attempt},
          ${nodeExecutionId},
          ${`job-${input.id}`},
          'queued',
          ${input.runtimeStatus},
          'node_run',
          ${input.creditCost ?? 0},
          ${input.inputSnapshot === undefined ? null : JSON.stringify(input.inputSnapshot)}::jsonb,
          now(),
          now(),
          now()
        )
      `;
      }),
    ),
  );
}

async function insertEffectNodeExecution(input: {
  readonly id: string;
  readonly nodeId?: string;
  readonly outputCount?: number;
  readonly ownerUserId?: string;
  readonly workflowId?: string;
}) {
  await ServerTestRuntime.runPromise(
    database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedEffectWorkflowSql(sql);
        yield* sql`
        insert into node_executions (
          id,
          workflow_id,
          owner_user_id,
          node_id,
          execution_id,
          status,
          output_count,
          target_reason,
          created_at,
          updated_at
        ) values (
          ${input.id},
          ${input.workflowId ?? "workflow-id"},
          ${input.ownerUserId ?? "owner-user"},
          ${input.nodeId ?? "node-id"},
          ${input.id},
          'pending',
          ${input.outputCount ?? 1},
          'node_run',
          now(),
          now()
        )
      `;
      }),
    ),
  );
}

async function setEffectCreditBalance(ownerUserId: string, balance: number) {
  await ServerTestRuntime.runPromise(
    database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedEffectWorkflowSql(sql);
        yield* sql`
        update "user"
        set credit_balance = ${balance}, updated_at = now()
        where id = ${ownerUserId}
      `;
      }),
    ),
  );
}

async function insertEffectTaskDependency(input: {
  readonly childTaskRunId: string;
  readonly parentItemIndex?: number;
  readonly parentNodeExecutionId: string;
  readonly parentNodeId?: string;
  readonly targetNodeId?: string;
}) {
  await ServerTestRuntime.runPromise(
    database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const parentItemIndex = input.parentItemIndex ?? 0;
        yield* sql`
        insert into task_dependencies (
          id,
          child_task_run_id,
          required_parent_node_execution_id,
          required_parent_node_id,
          required_parent_item_index,
          target_node_id,
          created_at
        ) values (
          ${`${input.childTaskRunId}:${input.parentNodeExecutionId}:${parentItemIndex}`},
          ${input.childTaskRunId},
          ${input.parentNodeExecutionId},
          ${input.parentNodeId ?? "node-id"},
          ${parentItemIndex},
          ${input.targetNodeId ?? "node-id"},
          now()
        )
      `;
      }),
    ),
  );
}

async function insertEffectCreditLedgerEntry(input: {
  readonly amount: number;
  readonly balanceAfter: number;
  readonly kind: "debit" | "refund";
  readonly reason?: string;
  readonly sourceKey: string;
}) {
  await ServerTestRuntime.runPromise(
    database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
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
          ${input.sourceKey},
          'owner-user',
          'workflow-id',
          ${input.kind},
          ${input.amount},
          ${input.balanceAfter},
          ${input.reason ?? "task_run_debit"},
          ${input.sourceKey},
          now()
        )
      `;
      }),
    ),
  );
}

async function countEffectAssetsForTaskRun(taskRunId: string): Promise<number> {
  return ServerTestRuntime.runPromise(
    database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly count: number }>`
        select count(*)::int as count from assets where task_run_id = ${taskRunId}
      `;
        return Number(rows[0]?.count ?? 0);
      }),
    ),
  );
}

function textGeneratedAsset(assetId: string, text: string) {
  return {
    assetId,
    contentType: "text/plain",
    fileName: `${assetId}.txt`,
    kind: "text" as const,
    sizeBytes: text.length,
    storageProvider: "inline",
    text,
  };
}

function mediaGeneratedAsset(assetId: string) {
  return {
    assetId,
    cdnUrl: `https://cdn.example.com/${assetId}.png`,
    contentType: "image/png",
    fileName: `${assetId}.png`,
    kind: "image" as const,
    sizeBytes: 1024,
    storageKey: `generated/${assetId}.png`,
    storageProvider: "s3",
  };
}

function nonRefundableProviderFailureSource() {
  return {
    taskRunDebitRefundable: false,
    type: "PROVIDER" as const,
  };
}

function refundableProviderFailureSource() {
  return {
    taskRunDebitRefundable: true,
    type: "PROVIDER" as const,
  };
}

async function seedEffectWorkflow() {
  await ServerTestRuntime.runPromise(
    database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedEffectWorkflowSql(sql);
      }),
    ),
  );
}

function seedEffectWorkflowSql(sql: SqlClient.SqlClient) {
  const workflowDocument = JSON.stringify({ edges: [], nodes: [], version: 1 });
  return Effect.gen(function* () {
    yield* sql`
      insert into "user" (
        id,
        name,
        email,
        email_verified,
        credit_balance,
        created_at,
        updated_at
      ) values (
        'owner-user',
        'Owner User',
        'owner-user@example.com',
        false,
        100,
        now(),
        now()
      ) on conflict (id) do nothing
    `;
    yield* sql`
      insert into workflows (
        id,
        owner_user_id,
        name,
        document,
        created_at,
        updated_at
      ) values (
        'workflow-id',
        'owner-user',
        'Workflow',
        ${workflowDocument}::jsonb,
        now(),
        now()
      ) on conflict (id) do nothing
    `;
  });
}

describe.serial("RuntimeRepository", () => {
  beforeAll(async () => {
    database = await ServerTestRuntime.runPromise(DatabaseService);
  });

  beforeEach(async () => {
    await resetEffectRuntimeTables();
  });

  afterAll(async () => {
    await rm(path.join(process.cwd(), ".data", "workflow-assets", "test"), {
      force: true,
      recursive: true,
    });
  });

  test("commits empty Workflow Run plans through the Effect SQL transaction layer", async () => {
    const repository = createRuntimeRepository();
    await seedEffectWorkflow();

    const result = await ServerTestRuntime.runPromise(
      repository.commitWorkflowRunPlan(
        workflowRunPlan({
          nodeExecutionsToCreate: [
            {
              id: "node-execution-empty-work",
              nodeId: "node-id",
              ownerId: "owner-user",
              workflowId: "workflow-id",
            },
          ],
        }),
      ),
    );

    assert.deepEqual(result, {
      postCommitWork: {
        executionJobs: [],
        source: "start-workflow-run",
        taskStatusEvents: [],
        wakeUpJobs: [],
        workflowId: "workflow-id",
      },
      value: {
        executionJobs: [],
        taskStatusEvents: [],
        wakeUpJobs: [],
      },
    });
  });

  test("returns a typed failure when a Wake-Up Call parent is missing", async () => {
    const repository = createRuntimeRepository();

    const result = await ServerTestRuntime.runPromise(
      Effect.flip(
        repository.wakeUpTaskRunChildren({
          ownerUserId: "owner-user",
          settledParentTaskRunId: "missing-parent",
          workflowId: "workflow-id",
        }),
      ),
    );

    assert.deepEqual(result, {
      _tag: "WakeUpParentNotFound",
      ownerUserId: "owner-user",
      settledParentTaskRunId: "missing-parent",
    });
  });

  test("settles Running completion through the Effect SQL transaction layer", async () => {
    const repository = createRuntimeRepository();
    await insertEffectTaskRun({
      id: "task-run-effect-complete",
      runtimeStatus: "RUNNING",
    });

    const result = await ServerTestRuntime.runPromise(
      repository.settleTaskRunCompletion({
        attempt: 0,
        generatedAsset: textGeneratedAsset("asset-effect-complete", "done"),
        ownerUserId: "owner-user",
        providerCostCredits: 0,
        reviewRequired: false,
        taskRunId: "task-run-effect-complete",
        workflowId: "workflow-id",
      }),
    );

    assert.equal(result.value.settled, true);
    assert.deepEqual(result.postCommitWork, {
      executionJobs: [],
      source: "settle-worker-completion",
      taskStatusEvents: [result.value.event],
      wakeUpJobs: result.value.wakeUpJob ? [result.value.wakeUpJob] : [],
      workflowId: "workflow-id",
    });
  });

  test("returns typed stale failure for duplicate completion settlement", async () => {
    const repository = createRuntimeRepository();
    await insertEffectTaskRun({
      id: "task-run-effect-stale-complete",
      runtimeStatus: "APPROVED",
    });

    const result = await ServerTestRuntime.runPromise(
      Effect.flip(
        repository.settleTaskRunCompletion({
          attempt: 0,
          generatedAsset: textGeneratedAsset("asset-effect-stale", "ignored"),
          ownerUserId: "owner-user",
          providerCostCredits: 0,
          reviewRequired: false,
          taskRunId: "task-run-effect-stale-complete",
          workflowId: "workflow-id",
        }),
      ),
    );

    assert.deepEqual(result, {
      _tag: "StaleTaskRunTransition",
      attempt: 0,
      operation: "settleTaskRunCompletion",
      taskRunId: "task-run-effect-stale-complete",
    });
  });

  test("settles Running failure through the Effect SQL transaction layer", async () => {
    const repository = createRuntimeRepository();
    await insertEffectTaskRun({
      id: "task-run-effect-failure",
      runtimeStatus: "RUNNING",
    });

    const result = await ServerTestRuntime.runPromise(
      repository.settleTaskRunFailure({
        attempt: 0,
        failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
        failureSource: nonRefundableProviderFailureSource(),
        ownerUserId: "owner-user",
        providerCostCredits: 0,
        taskRunId: "task-run-effect-failure",
        workflowId: "workflow-id",
      }),
    );

    assert.equal(result.value.settled, true);
    assert.deepEqual(result.postCommitWork, {
      executionJobs: [],
      source: "settle-worker-failure",
      taskStatusEvents: [result.value.event],
      wakeUpJobs: [result.value.wakeUpJob],
      workflowId: "workflow-id",
    });
  });

  test("claims queued Task Runs through the Effect SQL transaction layer", async () => {
    const repository = createRuntimeRepository();
    const snapshot = inputSnapshot("task-run-effect-claim", 0, {
      nodeExecutionId: "node-execution-effect-claim",
    });
    await insertEffectTaskRun({
      id: "task-run-effect-claim",
      inputSnapshot: snapshot,
      nodeExecutionId: "node-execution-effect-claim",
      runtimeStatus: "QUEUED",
    });

    const result = await ServerTestRuntime.runPromise(
      repository.claimQueuedTaskRun({
        attempt: 0,
        ownerUserId: "owner-user",
        taskRunId: "task-run-effect-claim",
      }),
    );

    assert.deepEqual(result, {
      claimed: true,
      event: {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-effect-claim",
        status: "RUNNING",
        taskRunId: "task-run-effect-claim",
      },
      inputSnapshot: snapshot,
    });
  });

  test("approves Pending Review Task Runs with post-commit wake-up work", async () => {
    const repository = createRuntimeRepository();
    await insertEffectTaskRun({
      id: "task-run-effect-approve",
      runtimeStatus: "PENDING_REVIEW",
    });

    const result = await ServerTestRuntime.runPromise(
      repository.approveTaskRun({
        attempt: 0,
        ownerUserId: "owner-user",
        taskRunId: "task-run-effect-approve",
        workflowId: "workflow-id",
      }),
    );

    assert.equal(result.value.decided, true);
    assert.deepEqual(result.postCommitWork, {
      executionJobs: [],
      source: "approve-task-run",
      taskStatusEvents: [result.value.event],
      wakeUpJobs: [result.value.wakeUpJob],
      workflowId: "workflow-id",
    });
  });

  test("rejects Pending Review Task Runs and queues regeneration through Effect SQL", async () => {
    const repository = createRuntimeRepository();
    await insertEffectTaskRun({
      attempt: 2,
      creditCost: 9,
      id: "task-run-effect-reject",
      inputSnapshot: inputSnapshot("task-run-effect-reject", 2, {
        nodeExecutionId: "node-execution-effect-reject",
      }),
      nodeExecutionId: "node-execution-effect-reject",
      runtimeStatus: "PENDING_REVIEW",
    });

    const result = await ServerTestRuntime.runPromise(
      repository.rejectTaskRunAndCreateRegeneration({
        attempt: 2,
        newTaskRunId: "task-run-effect-regenerated",
        ownerUserId: "owner-user",
        taskRunId: "task-run-effect-reject",
        workflowId: "workflow-id",
      }),
    );

    assert.equal(result.value.rejected, true);
    assert.deepEqual(result.postCommitWork.executionJobs, [
      result.value.executionJob,
    ]);
    assert.deepEqual(
      result.postCommitWork.taskStatusEvents,
      result.value.taskStatusEvents,
    );
  });

  test("expected claim misses return false without mutating terminal or mismatched Task Runs", async () => {
    const repository = createRuntimeRepository();
    await insertEffectTaskRun({
      attempt: 1,
      id: "task-run-effect-claim-miss",
      runtimeStatus: "QUEUED",
    });
    await insertEffectTaskRun({
      id: "task-run-effect-terminal-claim",
      runtimeStatus: "APPROVED",
    });

    assert.deepEqual(
      await ServerTestRuntime.runPromise(
        repository.claimQueuedTaskRun({
          attempt: 0,
          ownerUserId: "owner-user",
          taskRunId: "task-run-effect-claim-miss",
        }),
      ),
      { claimed: false },
    );
    assert.deepEqual(
      await ServerTestRuntime.runPromise(
        repository.claimQueuedTaskRun({
          attempt: 0,
          ownerUserId: "owner-user",
          taskRunId: "task-run-effect-terminal-claim",
        }),
      ),
      { claimed: false },
    );
  });

  test("settlement completion persists generated Assets, review state, wake-up work, and credit adjustment", async () => {
    const repository = createRuntimeRepository();
    await setEffectCreditBalance("owner-user", 20);
    await insertEffectTaskRun({
      creditCost: 3,
      id: "task-run-effect-reviewed-completion",
      runtimeStatus: "RUNNING",
    });

    const reviewed = await ServerTestRuntime.runPromise(
      repository.settleTaskRunCompletion({
        attempt: 0,
        generatedAsset: mediaGeneratedAsset("asset-effect-reviewed"),
        ownerUserId: "owner-user",
        providerCostCredits: 6.2,
        reviewRequired: true,
        taskRunId: "task-run-effect-reviewed-completion",
        workflowId: "workflow-id",
      }),
    );

    assert.equal(reviewed.value.settled, true);
    assert.equal(reviewed.value.event.status, "PENDING_REVIEW");
    assert.equal(reviewed.value.wakeUpJob, null);
    assert.equal(
      await countEffectAssetsForTaskRun("task-run-effect-reviewed-completion"),
      1,
    );
    assert.deepEqual(
      await ServerTestRuntime.runPromise(
        repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
      ),
      {
        creditBalance: 16,
        ledgerEntries: [
          {
            amount: 4,
            balanceAfter: 16,
            kind: "debit",
            sourceKey:
              "task_run:task-run-effect-reviewed-completion:cost_adjustment",
          },
        ],
      },
    );

    await insertEffectTaskRun({
      id: "task-run-effect-approved-completion",
      runtimeStatus: "RUNNING",
    });
    const approved = await ServerTestRuntime.runPromise(
      repository.settleTaskRunCompletion({
        attempt: 0,
        generatedAsset: textGeneratedAsset("asset-effect-approved", "done"),
        ownerUserId: "owner-user",
        providerCostCredits: 0,
        reviewRequired: false,
        taskRunId: "task-run-effect-approved-completion",
        workflowId: "workflow-id",
      }),
    );

    assert.equal(approved.value.settled, true);
    assert.equal(approved.value.event.status, "APPROVED");
    assert.deepEqual(approved.postCommitWork.wakeUpJobs, [
      approved.value.wakeUpJob,
    ]);
  });

  test("settlement completion caps provider cost adjustment by available balance", async () => {
    const repository = createRuntimeRepository();
    await setEffectCreditBalance("owner-user", 2);
    await insertEffectTaskRun({
      creditCost: 3,
      id: "task-run-effect-capped-adjustment",
      runtimeStatus: "RUNNING",
    });

    const settled = await ServerTestRuntime.runPromise(
      repository.settleTaskRunCompletion({
        attempt: 0,
        generatedAsset: textGeneratedAsset("asset-effect-capped", "done"),
        ownerUserId: "owner-user",
        providerCostCredits: 10,
        reviewRequired: false,
        taskRunId: "task-run-effect-capped-adjustment",
        workflowId: "workflow-id",
      }),
    );

    assert.equal(settled.value.settled, true);
    assert.deepEqual(
      await ServerTestRuntime.runPromise(
        repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
      ),
      {
        creditBalance: 0,
        ledgerEntries: [
          {
            amount: 2,
            balanceAfter: 0,
            kind: "debit",
            sourceKey:
              "task_run:task-run-effect-capped-adjustment:cost_adjustment",
          },
        ],
      },
    );
  });

  test("settlement failure applies refundable failures and leaves non-refundable failures billable", async () => {
    const repository = createRuntimeRepository();
    await setEffectCreditBalance("owner-user", 10);
    await insertEffectTaskRun({
      creditCost: 4,
      id: "task-run-effect-refundable-failure",
      runtimeStatus: "RUNNING",
    });
    await insertEffectCreditLedgerEntry({
      amount: 4,
      balanceAfter: 6,
      kind: "debit",
      sourceKey: "task_run:task-run-effect-refundable-failure:debit",
    });

    const refunded = await ServerTestRuntime.runPromise(
      repository.settleTaskRunFailure({
        attempt: 0,
        failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
        failureSource: refundableProviderFailureSource(),
        ownerUserId: "owner-user",
        providerCostCredits: 0,
        taskRunId: "task-run-effect-refundable-failure",
        workflowId: "workflow-id",
      }),
    );

    assert.equal(refunded.value.settled, true);
    assert.deepEqual(
      await ServerTestRuntime.runPromise(
        repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
      ),
      {
        creditBalance: 14,
        ledgerEntries: [
          {
            amount: 4,
            balanceAfter: 6,
            kind: "debit",
            sourceKey: "task_run:task-run-effect-refundable-failure:debit",
          },
          {
            amount: 4,
            balanceAfter: 14,
            kind: "refund",
            sourceKey: "task_run:task-run-effect-refundable-failure:refund",
          },
        ],
      },
    );

    await insertEffectTaskRun({
      creditCost: 4,
      id: "task-run-effect-non-refundable-failure",
      runtimeStatus: "RUNNING",
    });
    await ServerTestRuntime.runPromise(
      repository.settleTaskRunFailure({
        attempt: 0,
        failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
        failureSource: nonRefundableProviderFailureSource(),
        ownerUserId: "owner-user",
        providerCostCredits: 0,
        taskRunId: "task-run-effect-non-refundable-failure",
        workflowId: "workflow-id",
      }),
    );

    const ledger = await ServerTestRuntime.runPromise(
      repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
    );
    assert.equal(
      ledger.ledgerEntries.some(
        (entry) =>
          entry.sourceKey ===
          "task_run:task-run-effect-non-refundable-failure:refund",
      ),
      false,
    );
  });

  test("cancellation refunds queued Task Runs and blocks running or pending-review cancellation", async () => {
    const repository = createRuntimeRepository();
    await setEffectCreditBalance("owner-user", 8);
    await insertEffectTaskRun({
      creditCost: 5,
      id: "task-run-effect-cancel-queued",
      runtimeStatus: "QUEUED",
    });
    await insertEffectCreditLedgerEntry({
      amount: 5,
      balanceAfter: 3,
      kind: "debit",
      sourceKey: "task_run:task-run-effect-cancel-queued:debit",
    });

    const cancelled = await ServerTestRuntime.runPromise(
      repository.cancelTaskRun({
        attempt: 0,
        ownerUserId: "owner-user",
        taskRunId: "task-run-effect-cancel-queued",
        workflowId: "workflow-id",
      }),
    );
    assert.equal(cancelled.value.decided, true);
    assert.deepEqual(cancelled.postCommitWork.wakeUpJobs, [
      cancelled.value.wakeUpJob,
    ]);

    await insertEffectTaskRun({
      id: "task-run-effect-cancel-running",
      runtimeStatus: "RUNNING",
    });
    const runningBlocked = await ServerTestRuntime.runPromise(
      repository.cancelTaskRun({
        attempt: 0,
        ownerUserId: "owner-user",
        taskRunId: "task-run-effect-cancel-running",
        workflowId: "workflow-id",
      }),
    );
    assert.deepEqual(runningBlocked.value, {
      blocked: true,
      decided: false,
      message: "Running Task Runs cannot be cancelled.",
      reason: "RUNNING_TASK_RUN_CANCELLATION_BLOCKED",
    });

    await insertEffectTaskRun({
      id: "task-run-effect-cancel-pending-review",
      runtimeStatus: "PENDING_REVIEW",
    });
    const reviewBlocked = await ServerTestRuntime.runPromise(
      repository.cancelTaskRun({
        attempt: 0,
        ownerUserId: "owner-user",
        taskRunId: "task-run-effect-cancel-pending-review",
        workflowId: "workflow-id",
      }),
    );
    assert.deepEqual(reviewBlocked.value, {
      blocked: true,
      decided: false,
      message:
        "Pending Review Task Runs must be approved or rejected instead of cancelled.",
      reason: "PENDING_REVIEW_REQUIRES_REVIEW_DECISION",
    });
  });

  test("commit plans persist queued, failed, waiting, dependency, ledger, and rollback behavior", async () => {
    const repository = createRuntimeRepository();
    await setEffectCreditBalance("owner-user", 5);

    const committed = await ServerTestRuntime.runPromise(
      repository.commitWorkflowRunPlan(
        workflowRunPlan({
          nodeExecutionsToCreate: [
            {
              id: "node-execution-effect-source-plan",
              nodeId: "source-node",
              ownerId: "owner-user",
              workflowId: "workflow-id",
            },
            {
              id: "node-execution-effect-child-plan",
              nodeId: "child-node",
              ownerId: "owner-user",
              workflowId: "workflow-id",
            },
          ],
          taskDependenciesToCreate: [
            {
              childNodeExecutionId: "node-execution-effect-child-plan",
              childNodeId: "child-node",
              childTaskRunId: "task-run-effect-waiting-plan",
              parentItemIndex: 0,
              parentNodeExecutionId: "node-execution-effect-source-plan",
              parentNodeId: "source-node",
              targetNodeId: "child-node",
            },
          ],
          taskRunsToCreate: [
            {
              attempt: 0,
              creditCost: 3,
              id: "task-run-effect-funded-plan",
              itemIndex: 0,
              nodeExecutionId: "node-execution-effect-source-plan",
              nodeId: "source-node",
              status: "QUEUED",
            },
            {
              attempt: 0,
              creditCost: 4,
              id: "task-run-effect-unfunded-plan",
              itemIndex: 1,
              nodeExecutionId: "node-execution-effect-source-plan",
              nodeId: "source-node",
              status: "QUEUED",
            },
            {
              attempt: 0,
              creditCost: 0,
              id: "task-run-effect-waiting-plan",
              itemIndex: 0,
              nodeExecutionId: "node-execution-effect-child-plan",
              nodeId: "child-node",
              status: "WAITING_UPSTREAM",
            },
          ],
        }),
      ),
    );

    assert.deepEqual(
      committed.value.executionJobs.map((job) => job.taskRunId),
      ["task-run-effect-funded-plan"],
    );
    assert.deepEqual(
      committed.value.taskStatusEvents.map((event) => [
        event.taskRunId,
        event.status,
      ]),
      [
        ["task-run-effect-funded-plan", "QUEUED"],
        ["task-run-effect-unfunded-plan", "FAILED"],
        ["task-run-effect-waiting-plan", "WAITING_UPSTREAM"],
      ],
    );
    assert.deepEqual(
      await ServerTestRuntime.runPromise(
        repository.getTaskDependenciesForChild({
          childTaskRunId: "task-run-effect-waiting-plan",
        }),
      ),
      [
        {
          childTaskRunId: "task-run-effect-waiting-plan",
          requiredParentItemIndex: 0,
          requiredParentNodeExecutionId: "node-execution-effect-source-plan",
          requiredParentNodeId: "source-node",
          resolvedParentTaskRunId: null,
          sourceHandle: null,
          targetHandle: null,
          targetNodeId: "child-node",
        },
      ],
    );

    const rollback = await ServerTestRuntime.runPromise(
      Effect.flip(
        repository.commitWorkflowRunPlan(
          workflowRunPlan({
            nodeExecutionsToCreate: [
              {
                id: "node-execution-effect-rollback-a",
                nodeId: "rollback-node-a",
                ownerId: "owner-user",
                workflowId: "workflow-id",
              },
              {
                id: "node-execution-effect-rollback-a",
                nodeId: "rollback-node-b",
                ownerId: "owner-user",
                workflowId: "workflow-id",
              },
            ],
          }),
        ),
      ),
    );
    assert.equal(rollback._tag, "RuntimeRepositoryFailure");
  });

  test("commit plans can create Task Runs on reused Node Executions without new Node Executions", async () => {
    const repository = createRuntimeRepository();
    await insertEffectNodeExecution({
      id: "node-execution-effect-reused-plan",
      nodeId: "reused-node",
    });
    await setEffectCreditBalance("owner-user", 5);

    const committed = await ServerTestRuntime.runPromise(
      repository.commitWorkflowRunPlan(
        workflowRunPlan({
          nodeExecutionsToReuse: [
            {
              id: "node-execution-effect-reused-plan",
              nodeId: "reused-node",
            },
          ],
          taskRunsToCreate: [
            {
              attempt: 0,
              creditCost: 2,
              id: "task-run-effect-reused-plan",
              itemIndex: 0,
              nodeExecutionId: "node-execution-effect-reused-plan",
              nodeId: "reused-node",
              status: "QUEUED",
            },
          ],
        }),
      ),
    );

    assert.equal(committed.postCommitWork.workflowId, "workflow-id");
    assert.deepEqual(
      committed.value.executionJobs.map((job) => job.taskRunId),
      ["task-run-effect-reused-plan"],
    );
    const persistedTaskRuns = await ServerTestRuntime.runPromise(
      repository.getRuntimeTaskRunsForNodeExecution({
        nodeExecutionId: "node-execution-effect-reused-plan",
        ownerUserId: "owner-user",
      }),
    );
    assert.deepEqual(
      persistedTaskRuns.map((taskRun) => ({
        attempt: taskRun.attempt,
        id: taskRun.taskRunId,
        itemIndex: taskRun.itemIndex,
        status: taskRun.runtimeStatus,
      })),
      [
        {
          attempt: 0,
          id: "task-run-effect-reused-plan",
          itemIndex: 0,
          status: "QUEUED",
        },
      ],
    );
  });

  test("Wake-Up Calls queue waiting children, resolve parent identity, debit once, and ignore duplicates", async () => {
    const repository = createRuntimeRepository();
    await setEffectCreditBalance("owner-user", 20);
    await insertEffectTaskRun({
      id: "task-run-effect-wake-parent",
      nodeExecutionId: "node-execution-effect-wake-parent",
      runtimeStatus: "APPROVED",
    });
    await insertEffectTaskRun({
      creditCost: 6,
      id: "task-run-effect-wake-child",
      inputSnapshot: inputSnapshot("task-run-effect-wake-child", 0, {
        nodeExecutionId: "node-execution-effect-wake-child",
      }),
      nodeExecutionId: "node-execution-effect-wake-child",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertEffectTaskDependency({
      childTaskRunId: "task-run-effect-wake-child",
      parentNodeExecutionId: "node-execution-effect-wake-parent",
    });

    const first = await ServerTestRuntime.runPromise(
      repository.wakeUpTaskRunChildren({
        ownerUserId: "owner-user",
        settledParentTaskRunId: "task-run-effect-wake-parent",
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(first.value.executionJobs, [
      {
        attempt: 0,
        itemIndex: 0,
        jobId: "task-run~task-run-effect-wake-child~attempt~0~execute",
        nodeExecutionId: "node-execution-effect-wake-child",
        ownerUserId: "owner-user",
        taskRunId: "task-run-effect-wake-child",
        workflowId: "workflow-id",
      },
    ]);
    assert.deepEqual(
      await ServerTestRuntime.runPromise(
        repository.getTaskDependenciesForChild({
          childTaskRunId: "task-run-effect-wake-child",
        }),
      ),
      [
        {
          childTaskRunId: "task-run-effect-wake-child",
          requiredParentItemIndex: 0,
          requiredParentNodeExecutionId: "node-execution-effect-wake-parent",
          requiredParentNodeId: "node-id",
          resolvedParentTaskRunId: "task-run-effect-wake-parent",
          sourceHandle: null,
          targetHandle: null,
          targetNodeId: "node-id",
        },
      ],
    );

    const duplicate = await ServerTestRuntime.runPromise(
      repository.wakeUpTaskRunChildren({
        ownerUserId: "owner-user",
        settledParentTaskRunId: "task-run-effect-wake-parent",
        workflowId: "workflow-id",
      }),
    );
    assert.deepEqual(duplicate.value, {
      executionJobs: [],
      parentFound: true,
      taskStatusEvents: [],
    });
    assert.deepEqual(
      (
        await ServerTestRuntime.runPromise(
          repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
        )
      ).ledgerEntries.filter((entry) =>
        entry.sourceKey.includes("task-run-effect-wake-child"),
      ),
      [
        {
          amount: 6,
          balanceAfter: 14,
          kind: "debit",
          sourceKey: "task_run:task-run-effect-wake-child:debit",
        },
      ],
    );
  });

  test("Wake-Up Calls propagate upstream failure from the latest parent attempt through the Effect transaction", async () => {
    const repository = createRuntimeRepository();
    await insertEffectTaskRun({
      attempt: 0,
      id: "task-run-effect-stale-approved-parent",
      nodeExecutionId: "node-execution-effect-stale-parent",
      runtimeStatus: "APPROVED",
    });
    await insertEffectTaskRun({
      attempt: 1,
      id: "task-run-effect-latest-failed-parent",
      nodeExecutionId: "node-execution-effect-stale-parent",
      runtimeStatus: "FAILED",
    });
    await insertEffectTaskRun({
      id: "task-run-effect-upstream-failed-child",
      inputSnapshot: inputSnapshot("task-run-effect-upstream-failed-child", 0, {
        nodeExecutionId: "node-execution-effect-upstream-failed-child",
      }),
      nodeExecutionId: "node-execution-effect-upstream-failed-child",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertEffectTaskDependency({
      childTaskRunId: "task-run-effect-upstream-failed-child",
      parentNodeExecutionId: "node-execution-effect-stale-parent",
    });

    const result = await ServerTestRuntime.runPromise(
      repository.wakeUpTaskRunChildren({
        ownerUserId: "owner-user",
        settledParentTaskRunId: "task-run-effect-stale-approved-parent",
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(result.value, {
      executionJobs: [],
      parentFound: true,
      taskStatusEvents: [
        {
          attempt: 0,
          failureReason: "UPSTREAM_FAILED",
          itemIndex: 0,
          nodeExecutionId: "node-execution-effect-upstream-failed-child",
          status: "UPSTREAM_FAILED",
          taskRunId: "task-run-effect-upstream-failed-child",
        },
      ],
    });
    assert.equal(result.durableStateChanged, true);
    assert.deepEqual(result.postCommitWork, {
      executionJobs: [],
      source: "handle-wake-up-call",
      taskStatusEvents: result.value.taskStatusEvents,
      wakeUpJobs: [],
      workflowId: "workflow-id",
    });
    assert.deepEqual(
      (
        await ServerTestRuntime.runPromise(
          repository.getRuntimeTaskRunsForNodeExecution({
            nodeExecutionId: "node-execution-effect-upstream-failed-child",
            ownerUserId: "owner-user",
          }),
        )
      ).map((taskRun) => ({
        id: taskRun.taskRunId,
        status: taskRun.runtimeStatus,
      })),
      [
        {
          id: "task-run-effect-upstream-failed-child",
          status: "UPSTREAM_FAILED",
        },
      ],
    );
  });
});

type WorkflowRunPlanInput = Partial<
  Omit<WorkflowRunPlan, "taskRunsToCreate">
> & {
  readonly taskRunsToCreate?: readonly (Omit<
    WorkflowRunPlan["taskRunsToCreate"][number],
    "targetNodeConfig"
  > &
    Partial<
      Pick<WorkflowRunPlan["taskRunsToCreate"][number], "targetNodeConfig">
    >)[];
};

function workflowRunPlan(input: WorkflowRunPlanInput): WorkflowRunPlan {
  const taskRunsToCreate = (input.taskRunsToCreate ?? []).map((taskRun) => ({
    ...taskRun,
    targetNodeConfig:
      taskRun.targetNodeConfig ?? defaultTargetNodeConfig(taskRun.nodeId),
  }));
  return {
    nodeExecutionsToCreate: input.nodeExecutionsToCreate ?? [],
    nodeExecutionsToReuse: input.nodeExecutionsToReuse ?? [],
    runCostPreview: input.runCostPreview ?? emptyRunCostPreview(),
    taskDependenciesToCreate: input.taskDependenciesToCreate ?? [],
    taskRunsToCreate,
    workflowDefinition: input.workflowDefinition ?? {
      edges: [],
      nodes: Array.from(
        new Map(
          taskRunsToCreate.map((taskRun) => [
            taskRun.targetNodeConfig.id,
            taskRun.targetNodeConfig,
          ]),
        ).values(),
      ),
      version: 9,
    },
  };
}

function emptyRunCostPreview(): WorkflowRunPlan["runCostPreview"] {
  return {
    excludedExisting: { items: [], totalCreditCost: 0 },
    failedBeforeQueue: { items: [], totalCreditCost: 0 },
    immediateDebitTotal: 0,
    items: [],
    newCostTotal: 0,
    queuedImmediate: { items: [], totalCreditCost: 0 },
    waitingUpstream: { items: [], totalCreditCost: 0 },
  };
}

function inputSnapshot(
  taskRunId: string,
  attempt: number,
  input: {
    readonly itemIndex?: number;
    readonly nodeExecutionId?: string;
    readonly nodeId?: string;
    readonly targetNodeConfig?: TaskRunInputSnapshot["targetNodeConfig"];
  } = {},
): TaskRunInputSnapshot {
  const nodeId = input.nodeId ?? "node-id";
  const targetNodeConfig =
    input.targetNodeConfig ?? defaultTargetNodeConfig(nodeId);
  return {
    attempt,
    documentRevision: null,
    idempotencyKey: `task_run:${taskRunId}:attempt:${attempt}`,
    itemIndex: input.itemIndex ?? 0,
    kind: "task-run-input-snapshot",
    nodeExecutionId: input.nodeExecutionId ?? `node-execution-${taskRunId}`,
    nodeId,
    providerInput: {
      kind: "llm-generation-request",
      request: {
        idempotencyKey: `task_run:${taskRunId}:attempt:${attempt}`,
        maxOutputTokens: 2048,
        mode: null,
        model: "gemini-3-flash-preview",
        prompt: "",
        referenceImages: [],
        systemPrompt: null,
        temperature: 1,
        thinkingLevel: "LOW",
      },
    },
    resolvedParentTaskRuns: [],
    targetNodeConfig,
    taskRunId,
    version: 1,
    workflowDefinition: {
      edges: [],
      nodes: [targetNodeConfig],
      version: 9,
    },
  };
}

function defaultTargetNodeConfig(
  nodeId: string,
): Extract<TaskRunInputSnapshot["targetNodeConfig"], { kind: "llmGenerator" }> {
  const node = createWorkflowNode("llmGenerator", 0);
  if (node.kind !== "llmGenerator") {
    throw new Error("Expected an LLM generator node.");
  }

  return { ...node, id: nodeId };
}
