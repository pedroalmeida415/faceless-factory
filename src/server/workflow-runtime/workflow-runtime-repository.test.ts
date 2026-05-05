import { afterAll, beforeAll, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import { createWorkflowNode } from "~/lib/workflow/document";
import type { TaskRunStatus } from "~/lib/workflow-runtime/domain/task-run-state";
import {
  isTaskRunInputSnapshot,
  type TaskRunInputSnapshot,
} from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
import type { WorkflowRunPlan } from "~/lib/workflow-runtime/planning/workflow-run-planner";
import { wakeUpTaskRunChildrenInRepository } from "~/server/workflow-runtime/workflow-runtime-gatekeeper-repository";
import { createWorkflowRuntimeRepository } from "~/server/workflow-runtime/workflow-runtime-repository";

describe("WorkflowRuntimeRepository", () => {
  let client: PGlite;
  let db: PgliteDatabase;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client);
    await setupRuntimeTables(db);
  });

  beforeEach(async () => {
    await resetRuntimeTables(db);
  });

  afterAll(async () => {
    await client.close();
    await rm(path.join(process.cwd(), ".data", "workflow-assets", "test"), {
      force: true,
      recursive: true,
    });
  });

  test("commits Workflow Run plans through the database transaction API", async () => {
    const calls: string[] = [];
    const repository = createWorkflowRuntimeRepository({
      execute: async () => {
        throw new Error("manual transaction SQL escaped the transaction API");
      },
      transaction: async (callback) => {
        calls.push("transaction");
        return callback({
          execute: async () => {
            throw new Error("empty plan should not execute SQL");
          },
        });
      },
    });

    const result = await repository.commitWorkflowRunPlan(workflowRunPlan({}));

    assert.deepEqual(result, {
      executionJobs: [],
      taskStatusEvents: [],
      wakeUpJobs: [],
    });
    assert.deepEqual(calls, ["transaction"]);
  });

  test("runs Wake-Up Calls through the database transaction API", async () => {
    const calls: string[] = [];
    const result = await wakeUpTaskRunChildrenInRepository(
      {
        execute: async () => {
          throw new Error("manual transaction SQL escaped the transaction API");
        },
        transaction: async (callback) => {
          calls.push("transaction");
          return callback({ execute: async () => [] });
        },
      },
      { ownerUserId: "owner-user", settledParentTaskRunId: "missing-parent" },
    );

    assert.deepEqual(result, { executionJobs: [], taskStatusEvents: [] });
    assert.deepEqual(calls, ["transaction"]);
  });

  test("Wake-Up Call persistence fails a Task Run instead of queueing without a debit", async () => {
    const results: readonly unknown[][] = [
      [{ ownerUserId: "owner-user", workflowId: "workflow-id" }],
      [
        gatekeeperTaskRunRow({
          id: "parent-approved-for-debit-denied",
          nodeExecutionId: "node-execution-parent-debit-denied",
          status: "APPROVED",
        }),
        gatekeeperTaskRunRow({
          estimatedCreditCost: 30,
          id: "child-debit-denied",
          inputSnapshot: inputSnapshot("child-debit-denied", 0, {
            nodeExecutionId: "node-execution-child-debit-denied",
          }),
          nodeExecutionId: "node-execution-child-debit-denied",
          status: "WAITING_UPSTREAM",
        }),
      ],
      [
        {
          assetId: "asset-parent-debit-denied",
          contentType: "text/plain",
          kind: "text",
          text: "approved parent text",
        },
      ],
      [],
      [
        {
          childTaskRunId: "child-debit-denied",
          requiredParentItemIndex: 0,
          requiredParentNodeExecutionId: "node-execution-parent-debit-denied",
          requiredParentNodeId: "parent-node",
          resolvedParentTaskRunId: null,
          sourceHandle: null,
          targetHandle: null,
          targetNodeId: "child-node",
        },
      ],
      [{ creditBalance: 0 }],
      [],
      [{ id: "child-debit-denied" }],
      [],
      [],
    ];
    let queryIndex = 0;

    const result = await wakeUpTaskRunChildrenInRepository(
      {
        execute: async () => {
          throw new Error("Wake-Up Call SQL escaped the transaction API");
        },
        transaction: async (callback) =>
          callback({ execute: async () => results[queryIndex++] ?? [] }),
      },
      {
        ownerUserId: "owner-user",
        settledParentTaskRunId: "parent-approved-for-debit-denied",
      },
    );

    assert.deepEqual(result, {
      executionJobs: [],
      taskStatusEvents: [
        {
          attempt: 0,
          failureReason: "INSUFFICIENT_CREDITS",
          itemIndex: 0,
          nodeExecutionId: "node-execution-child-debit-denied",
          status: "FAILED",
          taskRunId: "child-debit-denied",
        },
      ],
    });
  });

  test("claims a queued Task Run and returns the post-commit Running Task Status Event with the input snapshot", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    const snapshot = inputSnapshot("task-run-claimable", 0);
    await insertTaskRun(db, {
      id: "task-run-claimable",
      inputSnapshot: snapshot,
      nodeExecutionId: "node-execution-claimable",
      runtimeStatus: "QUEUED",
    });

    const result = await repository.claimQueuedTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "task-run-claimable",
    });

    assert.deepEqual(result, {
      claimed: true,
      event: {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-claimable",
        status: "RUNNING",
        taskRunId: "task-run-claimable",
      },
      inputSnapshot: snapshot,
    });
  });

  test("returns false for a duplicate claim after the durable status is Running", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      id: "task-run-duplicate",
      runtimeStatus: "QUEUED",
    });

    await repository.claimQueuedTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "task-run-duplicate",
    });
    const duplicate = await repository.claimQueuedTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "task-run-duplicate",
    });

    assert.deepEqual(duplicate, { claimed: false });
  });

  test("returns false when the Attempt identity does not match", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      attempt: 1,
      id: "task-run-attempt-1",
      runtimeStatus: "QUEUED",
    });

    const result = await repository.claimQueuedTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "task-run-attempt-1",
    });

    assert.deepEqual(result, { claimed: false });
  });

  test("returns false when the owner does not match", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      id: "task-run-owner",
      ownerUserId: "actual-owner",
      runtimeStatus: "QUEUED",
    });

    const result = await repository.claimQueuedTaskRun({
      attempt: 0,
      ownerUserId: "wrong-owner",
      taskRunId: "task-run-owner",
    });

    assert.deepEqual(result, { claimed: false });
  });

  test("returns false for terminal and missing Task Runs", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      id: "task-run-approved",
      runtimeStatus: "APPROVED",
    });

    assert.deepEqual(
      await repository.claimQueuedTaskRun({
        attempt: 0,
        ownerUserId: "owner-user",
        taskRunId: "task-run-approved",
      }),
      { claimed: false },
    );
    assert.deepEqual(
      await repository.claimQueuedTaskRun({
        attempt: 0,
        ownerUserId: "owner-user",
        taskRunId: "missing-task-run",
      }),
      { claimed: false },
    );
  });

  test("settles a Running Task Run into Pending Review with one renderable Asset", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      id: "task-run-review-complete",
      runtimeStatus: "RUNNING",
    });

    const result = await repository.settleTaskRunCompletion({
      attempt: 0,
      finalCostCredits: 17,
      generatedAsset: textGeneratedAsset("asset-review", "review text"),
      ownerUserId: "owner-user",
      reviewRequired: true,
      taskRunId: "task-run-review-complete",
    });

    assert.deepEqual(result, {
      settled: true,
      event: {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-task-run-review-complete",
        output: {
          assetId: "asset-review",
          kind: "inline-text-asset",
          text: "review text",
        },
        status: "PENDING_REVIEW",
        taskRunId: "task-run-review-complete",
      },
      wakeUpJob: null,
    });
    assert.deepEqual(
      await getTaskRunSettlement(db, "task-run-review-complete"),
      {
        assetIds: ["asset-review"],
        costCredits: 17,
        failedAt: null,
        failureReason: null,
        finishedAtIsSet: true,
        runtimeStatus: "PENDING_REVIEW",
      },
    );
    assert.equal(
      await countAssetsForTaskRun(db, "task-run-review-complete"),
      1,
    );
  });

  test("settles a Running Task Run into Approved and returns a Wake-Up Call draft", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      id: "task-run-approved-complete",
      runtimeStatus: "RUNNING",
    });

    const result = await repository.settleTaskRunCompletion({
      attempt: 0,
      finalCostCredits: 23,
      generatedAsset: mediaGeneratedAsset("asset-approved"),
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskRunId: "task-run-approved-complete",
    });

    assert.deepEqual(result, {
      settled: true,
      event: {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-task-run-approved-complete",
        output: {
          assetId: "asset-approved",
          cdnUrl: "https://cdn.example.com/asset-approved.png",
          contentType: "image/png",
          kind: "cdn-asset",
        },
        status: "APPROVED",
        taskRunId: "task-run-approved-complete",
      },
      wakeUpJob: {
        jobId: "wake-up~task-run-approved-complete",
        ownerUserId: "owner-user",
        parentTaskRunId: "task-run-approved-complete",
        workflowId: "workflow-id",
      },
    });
  });

  test("promotes staged media only during Task Run settlement", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    const stagedStorageKey = "test/staged-generated/image/staged-asset.png";
    const promotedStorageKey = "test/generated/image/staged-asset.png";
    const stagedPath = path.join(
      process.cwd(),
      ".data",
      "workflow-assets",
      stagedStorageKey,
    );
    const promotedPath = path.join(
      process.cwd(),
      ".data",
      "workflow-assets",
      promotedStorageKey,
    );
    await mkdir(path.dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, "image-bytes");
    await insertTaskRun(db, {
      id: "task-run-staged-complete",
      runtimeStatus: "RUNNING",
    });

    const result = await repository.settleTaskRunCompletion({
      attempt: 0,
      finalCostCredits: 0,
      generatedAsset: {
        ...mediaGeneratedAsset("asset-staged"),
        stagedStorageKey,
        storageKey: promotedStorageKey,
      },
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskRunId: "task-run-staged-complete",
    });

    assert.equal(result.settled, true);
    assert.equal(await readFile(promotedPath, "utf8"), "image-bytes");
    assert.deepEqual(await loadAssetStorage(db, "asset-staged"), {
      storageKey: promotedStorageKey,
      taskRunId: "task-run-staged-complete",
    });
  });

  test("approves a Pending Review Task Run and returns a downstream Wake-Up Call draft", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      id: "task-run-review-approved",
      runtimeStatus: "PENDING_REVIEW",
    });

    const result = await repository.approveTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "task-run-review-approved",
    });

    assert.deepEqual(result, {
      decided: true,
      event: {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-task-run-review-approved",
        status: "APPROVED",
        taskRunId: "task-run-review-approved",
      },
      wakeUpJob: {
        jobId: "wake-up~task-run-review-approved",
        ownerUserId: "owner-user",
        parentTaskRunId: "task-run-review-approved",
        workflowId: "workflow-id",
      },
    });
    assert.equal(
      (await getTaskRunSettlement(db, "task-run-review-approved"))
        .runtimeStatus,
      "APPROVED",
    );
  });

  test("does not approve when the Task Run is not Pending Review", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      id: "task-run-review-running",
      runtimeStatus: "RUNNING",
    });

    const result = await repository.approveTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "task-run-review-running",
    });

    assert.deepEqual(result, { decided: false });
    assert.equal(
      (await getTaskRunSettlement(db, "task-run-review-running")).runtimeStatus,
      "RUNNING",
    );
  });

  test("rejecting a dependency-free Pending Review Task Run queues a regeneration attempt", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 25 });
    await insertTaskRun(db, {
      attempt: 2,
      estimatedCreditCost: 9,
      id: "task-run-review-rejected",
      nodeExecutionId: "node-execution-rejected",
      runtimeStatus: "PENDING_REVIEW",
    });

    const result = await repository.rejectTaskRunAndCreateRegeneration({
      attempt: 2,
      newTaskRunId: "task-run-review-regenerated",
      ownerUserId: "owner-user",
      taskRunId: "task-run-review-rejected",
    });

    assert.deepEqual(result, {
      executionJob: {
        attempt: 3,
        itemIndex: 0,
        jobId: "task-run~task-run-review-regenerated~attempt~3~execute",
        nodeExecutionId: "node-execution-rejected",
        ownerUserId: "owner-user",
        taskRunId: "task-run-review-regenerated",
        workflowId: "workflow-id",
      },
      rejected: true,
      taskStatusEvents: [
        {
          attempt: 2,
          itemIndex: 0,
          nodeExecutionId: "node-execution-rejected",
          status: "REJECTED",
          taskRunId: "task-run-review-rejected",
        },
        {
          attempt: 3,
          itemIndex: 0,
          nodeExecutionId: "node-execution-rejected",
          status: "QUEUED",
          taskRunId: "task-run-review-regenerated",
        },
      ],
    });
    assert.deepEqual(
      await repository.getRuntimeTaskRunsForNodeExecution({
        nodeExecutionId: "node-execution-rejected",
      }),
      [
        {
          attempt: 2,
          inputSnapshot: inputSnapshot("task-run-review-rejected", 2, {
            nodeExecutionId: "node-execution-rejected",
          }),
          itemIndex: 0,
          nodeExecutionId: "node-execution-rejected",
          ownerUserId: "owner-user",
          reservedCredits: null,
          runtimeStatus: "REJECTED",
          taskRunId: "task-run-review-rejected",
          workflowId: "workflow-id",
        },
        {
          attempt: 3,
          inputSnapshot: inputSnapshot("task-run-review-regenerated", 3, {
            nodeExecutionId: "node-execution-rejected",
          }),
          itemIndex: 0,
          nodeExecutionId: "node-execution-rejected",
          ownerUserId: "owner-user",
          reservedCredits: 9,
          runtimeStatus: "QUEUED",
          taskRunId: "task-run-review-regenerated",
          workflowId: "workflow-id",
        },
      ],
    );
    assert.equal(await getUserCreditBalance(db, "owner-user"), 16);
  });

  test("rejecting with a latest parent still Pending Review creates a Waiting Upstream regeneration attempt", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 25 });
    await insertTaskRun(db, {
      id: "parent-old-approved-for-reject",
      nodeExecutionId: "node-execution-parent-for-reject",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      attempt: 1,
      id: "parent-pending-for-reject",
      nodeExecutionId: "node-execution-parent-for-reject",
      runtimeStatus: "PENDING_REVIEW",
    });
    await insertTaskRun(db, {
      estimatedCreditCost: 9,
      id: "child-reject-waits",
      nodeExecutionId: "node-execution-child-reject-waits",
      runtimeStatus: "PENDING_REVIEW",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-reject-waits",
      parentNodeExecutionId: "node-execution-parent-for-reject",
    });

    const result = await repository.rejectTaskRunAndCreateRegeneration({
      attempt: 0,
      newTaskRunId: "child-reject-waits-next",
      ownerUserId: "owner-user",
      taskRunId: "child-reject-waits",
    });

    assert.deepEqual(result, {
      executionJob: null,
      rejected: true,
      taskStatusEvents: [
        {
          attempt: 0,
          itemIndex: 0,
          nodeExecutionId: "node-execution-child-reject-waits",
          status: "REJECTED",
          taskRunId: "child-reject-waits",
        },
        {
          attempt: 1,
          itemIndex: 0,
          nodeExecutionId: "node-execution-child-reject-waits",
          status: "WAITING_UPSTREAM",
          taskRunId: "child-reject-waits-next",
        },
      ],
    });
    assert.equal(
      (await getTaskRunCreditState(db, "child-reject-waits-next"))
        .runtimeStatus,
      "WAITING_UPSTREAM",
    );
    assert.deepEqual(
      await repository.getTaskDependenciesForChild({
        childTaskRunId: "child-reject-waits-next",
      }),
      [
        {
          childTaskRunId: "child-reject-waits-next",
          requiredParentItemIndex: 0,
          requiredParentNodeId: "node-id",
          requiredParentNodeExecutionId: "node-execution-parent-for-reject",
          resolvedParentTaskRunId: null,
          sourceHandle: null,
          targetHandle: null,
          targetNodeId: "node-id",
        },
      ],
    );
    assert.equal(await getUserCreditBalance(db, "owner-user"), 25);
  });

  test("rejecting an otherwise queueable Task Run creates a Failed regeneration attempt when credits are insufficient", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 4 });
    await insertTaskRun(db, {
      estimatedCreditCost: 9,
      id: "child-reject-unfunded",
      nodeExecutionId: "node-execution-child-reject-unfunded",
      runtimeStatus: "PENDING_REVIEW",
    });

    const result = await repository.rejectTaskRunAndCreateRegeneration({
      attempt: 0,
      newTaskRunId: "child-reject-unfunded-next",
      ownerUserId: "owner-user",
      taskRunId: "child-reject-unfunded",
    });

    assert.deepEqual(result, {
      executionJob: null,
      rejected: true,
      taskStatusEvents: [
        {
          attempt: 0,
          itemIndex: 0,
          nodeExecutionId: "node-execution-child-reject-unfunded",
          status: "REJECTED",
          taskRunId: "child-reject-unfunded",
        },
        {
          attempt: 1,
          failureReason: "INSUFFICIENT_CREDITS",
          itemIndex: 0,
          nodeExecutionId: "node-execution-child-reject-unfunded",
          status: "FAILED",
          taskRunId: "child-reject-unfunded-next",
        },
      ],
    });
    assert.deepEqual(
      await getTaskRunCreditState(db, "child-reject-unfunded-next"),
      {
        estimatedCreditCost: 9,
        failureReason: "INSUFFICIENT_CREDITS",
        reservedCredits: null,
        runtimeStatus: "FAILED",
      },
    );
    assert.deepEqual(await getCreditLedgerEntries(db), []);
  });

  test("rejecting the wrong status is a no-op", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      id: "task-run-reject-noop",
      runtimeStatus: "APPROVED",
    });

    const result = await repository.rejectTaskRunAndCreateRegeneration({
      attempt: 0,
      newTaskRunId: "task-run-reject-noop-next",
      ownerUserId: "owner-user",
      taskRunId: "task-run-reject-noop",
    });

    assert.deepEqual(result, { rejected: false });
    assert.deepEqual(
      await repository.getRuntimeTaskRunsForNodeExecution({
        nodeExecutionId: "node-execution-task-run-reject-noop",
      }),
      [
        {
          attempt: 0,
          inputSnapshot: inputSnapshot("task-run-reject-noop", 0),
          itemIndex: 0,
          nodeExecutionId: "node-execution-task-run-reject-noop",
          ownerUserId: "owner-user",
          reservedCredits: null,
          runtimeStatus: "APPROVED",
          taskRunId: "task-run-reject-noop",
          workflowId: "workflow-id",
        },
      ],
    );
  });

  test("rejecting copies dependencies and resolves them to latest Approved parent attempts", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 25 });
    await insertTaskRun(db, {
      id: "parent-stale-approved-for-reject",
      nodeExecutionId: "node-execution-parent-approved-reject",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      attempt: 1,
      id: "parent-latest-approved-for-reject",
      nodeExecutionId: "node-execution-parent-approved-reject",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      estimatedCreditCost: 5,
      id: "child-reject-ready",
      nodeExecutionId: "node-execution-child-reject-ready",
      runtimeStatus: "PENDING_REVIEW",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-reject-ready",
      parentNodeExecutionId: "node-execution-parent-approved-reject",
      parentNodeId: "parent-node",
      sourceHandle: "text",
      targetHandle: "prompt",
      targetNodeId: "child-node",
    });

    const result = await repository.rejectTaskRunAndCreateRegeneration({
      attempt: 0,
      newTaskRunId: "child-reject-ready-next",
      ownerUserId: "owner-user",
      taskRunId: "child-reject-ready",
    });

    assert.equal(result.rejected, true);
    assert.deepEqual(
      await repository.getTaskDependenciesForChild({
        childTaskRunId: "child-reject-ready-next",
      }),
      [
        {
          childTaskRunId: "child-reject-ready-next",
          requiredParentItemIndex: 0,
          requiredParentNodeId: "parent-node",
          requiredParentNodeExecutionId:
            "node-execution-parent-approved-reject",
          resolvedParentTaskRunId: "parent-latest-approved-for-reject",
          sourceHandle: "text",
          targetHandle: "prompt",
          targetNodeId: "child-node",
        },
      ],
    );
    assert.deepEqual(
      await getWakeUpTaskRunState(db, "child-reject-ready-next"),
      {
        error: null,
        inputSnapshot: {
          ...inputSnapshot("child-reject-ready-next", 1, {
            nodeExecutionId: "node-execution-child-reject-ready",
          }),
          resolvedParentTaskRuns: [
            {
              address: {
                parentItemIndex: 0,
                parentNodeId: "parent-node",
                sourceHandle: "text",
                targetHandle: "prompt",
                targetNodeId: "child-node",
              },
              attempt: 1,
              itemIndex: 0,
              nodeExecutionId: "node-execution-parent-approved-reject",
              taskRunId: "parent-latest-approved-for-reject",
            },
          ],
        },
        reservedCredits: 5,
        runtimeStatus: "QUEUED",
      },
    );
  });

  test("cancels a Waiting Upstream Task Run without creating a credit entry", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 70 });
    await insertTaskRun(db, {
      estimatedCreditCost: 30,
      id: "task-run-waiting-cancelled",
      runtimeStatus: "WAITING_UPSTREAM",
    });

    const result = await repository.cancelTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "task-run-waiting-cancelled",
    });

    assert.deepEqual(result, {
      decided: true,
      event: {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-task-run-waiting-cancelled",
        status: "CANCELLED",
        taskRunId: "task-run-waiting-cancelled",
      },
      wakeUpJob: {
        jobId: "wake-up~task-run-waiting-cancelled",
        ownerUserId: "owner-user",
        parentTaskRunId: "task-run-waiting-cancelled",
        workflowId: "workflow-id",
      },
    });
    assert.equal(
      (await getTaskRunSettlement(db, "task-run-waiting-cancelled"))
        .runtimeStatus,
      "CANCELLED",
    );
    assert.deepEqual(
      await repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
      { creditBalance: 70, ledgerEntries: [] },
    );
  });

  test("refunds one full Task Run Debit idempotently when cancelling a Queued Task Run", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 70 });
    await insertTaskRun(db, {
      estimatedCreditCost: 30,
      id: "task-run-queued-cancelled",
      reservedCredits: 30,
      runtimeStatus: "QUEUED",
    });

    await repository.cancelTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "task-run-queued-cancelled",
    });
    const duplicate = await repository.cancelTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "task-run-queued-cancelled",
    });

    assert.deepEqual(duplicate, { decided: false });
    assert.deepEqual(
      await repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
      {
        creditBalance: 100,
        ledgerEntries: [
          {
            amount: 30,
            balanceAfter: 100,
            kind: "refund",
            sourceKey: "task_run:task-run-queued-cancelled:refund",
          },
        ],
      },
    );
  });

  test("blocks Running Task Run cancellation with a predictable runtime error", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 80 });
    await insertTaskRun(db, {
      id: "task-run-running-cancel-blocked",
      reservedCredits: 20,
      runtimeStatus: "RUNNING",
    });

    const result = await repository.cancelTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "task-run-running-cancel-blocked",
    });

    assert.deepEqual(result, {
      blocked: true,
      decided: false,
      message: "Running Task Runs cannot be cancelled.",
      reason: "RUNNING_TASK_RUN_CANCELLATION_BLOCKED",
    });
    assert.equal(
      (await getTaskRunSettlement(db, "task-run-running-cancel-blocked"))
        .runtimeStatus,
      "RUNNING",
    );
    assert.deepEqual(
      await repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
      { creditBalance: 80, ledgerEntries: [] },
    );
  });

  test("blocks Pending Review cancellation so review decisions remain authoritative", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 80 });
    await insertTaskRun(db, {
      id: "task-run-review-cancel-blocked",
      reservedCredits: 20,
      runtimeStatus: "PENDING_REVIEW",
    });

    const result = await repository.cancelTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "task-run-review-cancel-blocked",
    });

    assert.deepEqual(result, {
      blocked: true,
      decided: false,
      message:
        "Pending Review Task Runs must be approved or rejected instead of cancelled.",
      reason: "PENDING_REVIEW_REQUIRES_REVIEW_DECISION",
    });
    assert.equal(
      (await getTaskRunSettlement(db, "task-run-review-cancel-blocked"))
        .runtimeStatus,
      "PENDING_REVIEW",
    );
    assert.deepEqual(
      await repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
      { creditBalance: 80, ledgerEntries: [] },
    );
  });

  test("does not cancel terminal Task Runs", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      id: "task-run-terminal-approved",
      runtimeStatus: "APPROVED",
    });

    const result = await repository.cancelTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "task-run-terminal-approved",
    });

    assert.deepEqual(result, { decided: false });
    assert.equal(
      (await getTaskRunSettlement(db, "task-run-terminal-approved"))
        .runtimeStatus,
      "APPROVED",
    );
  });

  test("settles a Running Task Run failure and returns a downstream Wake-Up Call draft", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      id: "task-run-failed",
      runtimeStatus: "RUNNING",
    });

    const result = await repository.settleTaskRunFailure({
      attempt: 0,
      failureReason: { message: "provider timed out", type: "PROVIDER_FAILED" },
      failureSource: nonRefundableProviderFailureSource(),
      finalCostCredits: 5,
      ownerUserId: "owner-user",
      taskRunId: "task-run-failed",
    });

    assert.deepEqual(result, {
      settled: true,
      event: {
        attempt: 0,
        failureReason: "PROVIDER_FAILED",
        itemIndex: 0,
        nodeExecutionId: "node-execution-task-run-failed",
        status: "FAILED",
        taskRunId: "task-run-failed",
      },
      wakeUpJob: {
        jobId: "wake-up~task-run-failed",
        ownerUserId: "owner-user",
        parentTaskRunId: "task-run-failed",
        workflowId: "workflow-id",
      },
    });
    assert.deepEqual(await getTaskRunSettlement(db, "task-run-failed"), {
      assetIds: [],
      costCredits: 5,
      failedAt: "set",
      failureReason: "PROVIDER_FAILED",
      finishedAtIsSet: false,
      runtimeStatus: "FAILED",
    });
  });

  test("non-refundable running provider failures keep the Task Run Debit billable", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 50 });
    await insertTaskRun(db, {
      estimatedCreditCost: 40,
      id: "task-run-failed-billable",
      reservedCredits: 40,
      runtimeStatus: "RUNNING",
    });

    await repository.settleTaskRunFailure({
      attempt: 0,
      failureReason: {
        message: "provider failed after spend",
        type: "PROVIDER_FAILED",
      },
      failureSource: nonRefundableProviderFailureSource(),
      ownerUserId: "owner-user",
      taskRunId: "task-run-failed-billable",
    });

    assert.equal(
      (await getTaskRunSettlement(db, "task-run-failed-billable")).costCredits,
      0,
    );
    assert.deepEqual(
      await repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
      {
        creditBalance: 50,
        ledgerEntries: [],
      },
    );
  });

  test("explicitly refundable failures create one full Task Run Refund idempotently", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 60 });
    await insertTaskRun(db, {
      estimatedCreditCost: 30,
      id: "task-run-refundable-failure",
      reservedCredits: 30,
      runtimeStatus: "RUNNING",
    });

    await repository.settleTaskRunFailure({
      attempt: 0,
      failureReason: {
        message: "provider confirmed no bill",
        type: "PROVIDER_FAILED",
      },
      failureSource: refundableProviderFailureSource(),
      ownerUserId: "owner-user",
      taskRunId: "task-run-refundable-failure",
    });
    await repository.settleTaskRunFailure({
      attempt: 0,
      failureReason: { message: "duplicate", type: "PROVIDER_FAILED" },
      failureSource: refundableProviderFailureSource(),
      ownerUserId: "owner-user",
      taskRunId: "task-run-refundable-failure",
    });

    assert.deepEqual(
      await repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
      {
        creditBalance: 90,
        ledgerEntries: [
          {
            amount: 30,
            balanceAfter: 90,
            kind: "refund",
            sourceKey: "task_run:task-run-refundable-failure:refund",
          },
        ],
      },
    );
  });

  test("post-provider infrastructure failures do not automatically refund Task Run Debit", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 10 });
    await insertTaskRun(db, {
      estimatedCreditCost: 20,
      id: "task-run-post-provider-failed",
      reservedCredits: 20,
      runtimeStatus: "RUNNING",
    });

    await repository.settleTaskRunFailure({
      attempt: 0,
      failureReason: {
        message: "asset promotion failed",
        type: "EXECUTION_FAILED",
      },
      failureSource: postProviderInfrastructureFailureSource(),
      ownerUserId: "owner-user",
      taskRunId: "task-run-post-provider-failed",
    });

    assert.deepEqual(
      await repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
      { creditBalance: 10, ledgerEntries: [] },
    );
  });

  test("LLM overage creates no adjustment at or below Task Run credit cost", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 60 });
    await insertTaskRun(db, {
      estimatedCreditCost: 30,
      id: "task-run-no-overage",
      reservedCredits: 30,
      runtimeStatus: "RUNNING",
    });

    await repository.settleTaskRunCompletion({
      attempt: 0,
      finalCostCredits: 30,
      generatedAsset: textGeneratedAsset("asset-no-overage", "no overage"),
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskRunId: "task-run-no-overage",
    });

    assert.deepEqual(
      await repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
      { creditBalance: 60, ledgerEntries: [] },
    );
  });

  test("positive LLM overage is rounded up, capped by balance, and idempotent", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 5 });
    await insertTaskRun(db, {
      estimatedCreditCost: 20,
      id: "task-run-overage-rounded",
      reservedCredits: 20,
      runtimeStatus: "RUNNING",
    });
    await insertTaskRun(db, {
      estimatedCreditCost: 10,
      id: "task-run-overage-capped",
      reservedCredits: 10,
      runtimeStatus: "RUNNING",
    });

    await repository.settleTaskRunCompletion({
      attempt: 0,
      finalCostCredits: 22,
      generatedAsset: textGeneratedAsset("asset-overage-rounded", "overage"),
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskRunId: "task-run-overage-rounded",
    });
    await repository.settleTaskRunCompletion({
      attempt: 0,
      finalCostCredits: 20,
      generatedAsset: textGeneratedAsset("asset-overage-capped", "capped"),
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskRunId: "task-run-overage-capped",
    });
    await repository.settleTaskRunCompletion({
      attempt: 0,
      finalCostCredits: 20,
      generatedAsset: textGeneratedAsset(
        "asset-overage-capped-duplicate",
        "duplicate",
      ),
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskRunId: "task-run-overage-capped",
    });

    assert.deepEqual(
      await repository.getCreditLedgerForUser({ ownerUserId: "owner-user" }),
      {
        creditBalance: 0,
        ledgerEntries: [
          {
            amount: 2,
            balanceAfter: 3,
            kind: "debit",
            sourceKey: "task_run:task-run-overage-rounded:cost_adjustment",
          },
          {
            amount: 3,
            balanceAfter: 0,
            kind: "debit",
            sourceKey: "task_run:task-run-overage-capped:cost_adjustment",
          },
        ],
      },
    );
  });

  test("does not settle completion or failure when the Attempt identity does not match", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      attempt: 1,
      id: "task-run-wrong-settle-attempt",
      runtimeStatus: "RUNNING",
    });

    assert.deepEqual(
      await repository.settleTaskRunCompletion({
        attempt: 0,
        finalCostCredits: 3,
        generatedAsset: textGeneratedAsset("asset-wrong-attempt", "ignored"),
        ownerUserId: "owner-user",
        reviewRequired: false,
        taskRunId: "task-run-wrong-settle-attempt",
      }),
      { settled: false },
    );
    assert.deepEqual(
      await repository.settleTaskRunFailure({
        attempt: 0,
        failureReason: { type: "EXECUTION_FAILED", message: "ignored" },
        failureSource: nonRefundableProviderFailureSource(),
        ownerUserId: "owner-user",
        taskRunId: "task-run-wrong-settle-attempt",
      }),
      { settled: false },
    );
    assert.equal(
      await countAssetsForTaskRun(db, "task-run-wrong-settle-attempt"),
      0,
    );
    assert.equal(
      (await getTaskRunSettlement(db, "task-run-wrong-settle-attempt"))
        .runtimeStatus,
      "RUNNING",
    );
  });

  test("does not duplicate Assets for duplicate completion settlement", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      id: "task-run-duplicate-completion",
      runtimeStatus: "RUNNING",
    });

    await repository.settleTaskRunCompletion({
      attempt: 0,
      finalCostCredits: 11,
      generatedAsset: textGeneratedAsset("asset-duplicate", "first"),
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskRunId: "task-run-duplicate-completion",
    });
    const duplicate = await repository.settleTaskRunCompletion({
      attempt: 0,
      finalCostCredits: 11,
      generatedAsset: textGeneratedAsset("asset-duplicate-second", "second"),
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskRunId: "task-run-duplicate-completion",
    });

    assert.deepEqual(duplicate, { settled: false });
    assert.equal(
      await countAssetsForTaskRun(db, "task-run-duplicate-completion"),
      1,
    );
  });

  test("lists deterministic execution job drafts for durable queued Task Runs", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      attempt: 2,
      id: "task-run-b",
      inputSnapshot: inputSnapshot("task-run-b", 2),
      runtimeStatus: "QUEUED",
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    await insertTaskRun(db, {
      attempt: 1,
      id: "task-run-a",
      inputSnapshot: inputSnapshot("task-run-a", 1),
      runtimeStatus: "QUEUED",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    await insertTaskRun(db, {
      id: "task-run-running",
      runtimeStatus: "RUNNING",
    });

    assert.deepEqual(await repository.listQueuedTaskRunJobs({ limit: 10 }), [
      {
        attempt: 1,
        itemIndex: 0,
        jobId: "task-run~task-run-a~attempt~1~execute",
        nodeExecutionId: "node-execution-task-run-a",
        ownerUserId: "owner-user",
        taskRunId: "task-run-a",
        workflowId: "workflow-id",
      },
      {
        attempt: 2,
        itemIndex: 0,
        jobId: "task-run~task-run-b~attempt~2~execute",
        nodeExecutionId: "node-execution-task-run-b",
        ownerUserId: "owner-user",
        taskRunId: "task-run-b",
        workflowId: "workflow-id",
      },
    ]);
  });

  test("wakes a Waiting Upstream child when all latest parent Task Runs are Approved", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 100 });
    await insertTaskRun(db, {
      id: "parent-approved-a",
      nodeExecutionId: "node-execution-parent-a",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      id: "parent-approved-b",
      nodeExecutionId: "node-execution-parent-b",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      estimatedCreditCost: 30,
      id: "child-ready",
      nodeExecutionId: "node-execution-child-ready",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-ready",
      parentNodeExecutionId: "node-execution-parent-a",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-ready",
      parentNodeExecutionId: "node-execution-parent-b",
    });

    const result = await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "parent-approved-a",
    });

    assert.deepEqual(result.executionJobs, [
      {
        attempt: 0,
        itemIndex: 0,
        jobId: "task-run~child-ready~attempt~0~execute",
        nodeExecutionId: "node-execution-child-ready",
        ownerUserId: "owner-user",
        taskRunId: "child-ready",
        workflowId: "workflow-id",
      },
    ]);
    assert.deepEqual(result.taskStatusEvents, [
      {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-child-ready",
        status: "QUEUED",
        taskRunId: "child-ready",
      },
    ]);
    assert.deepEqual(await getWakeUpTaskRunState(db, "child-ready"), {
      error: null,
      inputSnapshot: {
        ...inputSnapshot("child-ready", 0, {
          nodeExecutionId: "node-execution-child-ready",
        }),
        resolvedParentTaskRuns: [
          {
            address: {
              parentItemIndex: 0,
              parentNodeId: "node-id",
              sourceHandle: null,
              targetHandle: null,
              targetNodeId: "node-id",
            },
            attempt: 0,
            itemIndex: 0,
            nodeExecutionId: "node-execution-parent-a",
            taskRunId: "parent-approved-a",
          },
          {
            address: {
              parentItemIndex: 0,
              parentNodeId: "node-id",
              sourceHandle: null,
              targetHandle: null,
              targetNodeId: "node-id",
            },
            attempt: 0,
            itemIndex: 0,
            nodeExecutionId: "node-execution-parent-b",
            taskRunId: "parent-approved-b",
          },
        ],
      },
      reservedCredits: 30,
      runtimeStatus: "QUEUED",
    });
    assert.equal(await getUserCreditBalance(db, "owner-user"), 70);
    assert.deepEqual(await getCreditLedgerEntries(db), [
      {
        amount: 30,
        balanceAfter: 70,
        kind: "debit",
        sourceKey: "task_run:child-ready:debit",
        userId: "owner-user",
      },
    ]);
  });

  test("wakes a child with durable parent Asset metadata for provider reference images", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    const sourceNodeConfig = createWorkflowNode("imageGenerator", 0);
    const targetNodeConfig = createWorkflowNode("imageGenerator", 0);
    await insertUser(db, { creditBalance: 100 });
    await insertTaskRun(db, {
      id: "parent-approved-asset",
      nodeExecutionId: "node-execution-parent-asset",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedMediaAsset(db, {
      assetId: "asset-parent-approved",
      taskRunId: "parent-approved-asset",
    });
    await insertTaskRun(db, {
      estimatedCreditCost: 10,
      id: "child-ready-asset",
      inputSnapshot: inputSnapshot("child-ready-asset", 0, {
        nodeExecutionId: "node-execution-child-ready-asset",
        targetNodeConfig: {
          ...targetNodeConfig,
          id: "target-image-node",
        },
      }),
      nodeExecutionId: "node-execution-child-ready-asset",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-ready-asset",
      parentNodeId: "source-image-node",
      parentNodeExecutionId: "node-execution-parent-asset",
      sourceHandle: "images",
      targetHandle: "image-input-0",
      targetNodeId: "target-image-node",
    });

    await db.execute(sql`
      update task_runs
      set input_snapshot = ${{
        ...inputSnapshot("child-ready-asset", 0, {
          nodeExecutionId: "node-execution-child-ready-asset",
          targetNodeConfig: { ...targetNodeConfig, id: "target-image-node" },
        }),
        workflowDefinition: {
          edges: [
            {
              id: "source-to-target-image",
              source: "source-image-node",
              sourceHandle: "images",
              target: "target-image-node",
              targetHandle: "image-input-0",
            },
          ],
          nodes: [
            { ...sourceNodeConfig, id: "source-image-node" },
            { ...targetNodeConfig, id: "target-image-node" },
          ],
          version: 9,
        },
      }}::jsonb
      where id = 'child-ready-asset'
    `);

    await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "parent-approved-asset",
    });

    const state = await getWakeUpTaskRunState(db, "child-ready-asset");
    assert.equal(isTaskRunInputSnapshot(state.inputSnapshot), true);
    if (!isTaskRunInputSnapshot(state.inputSnapshot)) {
      throw new Error("Expected Task Run input snapshot");
    }
    const parent = state.inputSnapshot.resolvedParentTaskRuns[0];
    assert.equal(
      parent?.asset?.storagePath,
      "generated/asset-parent-approved.png",
    );
    assert.equal(parent?.output?.kind, "cdn-asset");
    assert.equal(
      state.inputSnapshot.providerInput.kind,
      "image-generation-request",
    );
    if (state.inputSnapshot.providerInput.kind !== "image-generation-request") {
      throw new Error("Expected image generation provider input");
    }
    assert.ok(state.inputSnapshot.providerInput.request.referenceImages);
    assert.equal(
      state.inputSnapshot.providerInput.request.referenceImages[0]?.storagePath,
      "generated/asset-parent-approved.png",
    );
  });

  test("Wake-Up Calls ignore unrelated rows without execution snapshots", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 100 });
    await insertTaskRun(db, {
      id: "unrelated-approved-without-snapshot",
      nodeExecutionId: "node-execution-unrelated-null-snapshot",
      runtimeStatus: "APPROVED",
    });
    await db.execute(sql`
      update task_runs
      set input_snapshot = null
      where id = 'unrelated-approved-without-snapshot'
    `);
    await insertTaskRun(db, {
      id: "parent-approved-parallel-slot",
      nodeExecutionId: "node-execution-parallel-parent",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedMediaAsset(db, {
      assetId: "asset-parent-approved-parallel-slot",
      taskRunId: "parent-approved-parallel-slot",
    });
    await insertTaskRun(db, {
      estimatedCreditCost: 10,
      id: "child-waiting-parallel-slot",
      inputSnapshot: inputSnapshot("child-waiting-parallel-slot", 0, {
        nodeExecutionId: "node-execution-parallel-child",
      }),
      nodeExecutionId: "node-execution-parallel-child",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-waiting-parallel-slot",
      parentNodeExecutionId: "node-execution-parallel-parent",
    });

    const result = await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "parent-approved-parallel-slot",
    });

    assert.deepEqual(result.executionJobs, [
      {
        attempt: 0,
        itemIndex: 0,
        jobId: "task-run~child-waiting-parallel-slot~attempt~0~execute",
        nodeExecutionId: "node-execution-parallel-child",
        ownerUserId: "owner-user",
        taskRunId: "child-waiting-parallel-slot",
        workflowId: "workflow-id",
      },
    ]);
    assert.equal(
      (await getWakeUpTaskRunState(db, "child-waiting-parallel-slot"))
        .runtimeStatus,
      "QUEUED",
    );
  });

  test("does not wake children while a latest parent Task Run is Pending Review", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 100 });
    await insertTaskRun(db, {
      id: "parent-approved-for-review-block",
      nodeExecutionId: "node-execution-parent-approved-review-block",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      attempt: 1,
      id: "parent-pending-review-latest",
      nodeExecutionId: "node-execution-parent-approved-review-block",
      runtimeStatus: "PENDING_REVIEW",
    });
    await insertTaskRun(db, {
      estimatedCreditCost: 10,
      id: "child-review-blocked",
      nodeExecutionId: "node-execution-child-review-blocked",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-review-blocked",
      parentNodeExecutionId: "node-execution-parent-approved-review-block",
    });

    const result = await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "parent-approved-for-review-block",
    });

    assert.deepEqual(result, { executionJobs: [], taskStatusEvents: [] });
    assert.equal(
      (await getWakeUpTaskRunState(db, "child-review-blocked")).runtimeStatus,
      "WAITING_UPSTREAM",
    );
    assert.equal(await getUserCreditBalance(db, "owner-user"), 100);
  });

  test("fails an unfunded child and cascades waiting descendants to Upstream Failed", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 5 });
    await insertTaskRun(db, {
      id: "parent-funded-blocker",
      nodeExecutionId: "node-execution-parent-funded-blocker",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      estimatedCreditCost: 20,
      id: "child-unfunded",
      nodeExecutionId: "node-execution-child-unfunded",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskRun(db, {
      estimatedCreditCost: 1,
      id: "grandchild-cascaded",
      nodeExecutionId: "node-execution-grandchild-cascaded",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-unfunded",
      parentNodeExecutionId: "node-execution-parent-funded-blocker",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "grandchild-cascaded",
      parentNodeExecutionId: "node-execution-child-unfunded",
    });

    const result = await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "parent-funded-blocker",
    });

    assert.deepEqual(result.executionJobs, []);
    assert.deepEqual(result.taskStatusEvents, [
      {
        attempt: 0,
        failureReason: "INSUFFICIENT_CREDITS",
        itemIndex: 0,
        nodeExecutionId: "node-execution-child-unfunded",
        status: "FAILED",
        taskRunId: "child-unfunded",
      },
      {
        attempt: 0,
        failureReason: "UPSTREAM_FAILED",
        itemIndex: 0,
        nodeExecutionId: "node-execution-grandchild-cascaded",
        status: "UPSTREAM_FAILED",
        taskRunId: "grandchild-cascaded",
      },
    ]);
    assert.equal(
      (await getWakeUpTaskRunState(db, "child-unfunded")).runtimeStatus,
      "FAILED",
    );
    assert.ok(
      isTaskRunInputSnapshot(
        (await getWakeUpTaskRunState(db, "child-unfunded")).inputSnapshot,
      ),
    );
    assert.equal(
      (await getWakeUpTaskRunState(db, "child-unfunded")).reservedCredits,
      null,
    );
    assert.equal(
      (await getWakeUpTaskRunState(db, "grandchild-cascaded")).runtimeStatus,
      "UPSTREAM_FAILED",
    );
    assert.equal(await getUserCreditBalance(db, "owner-user"), 5);
    assert.deepEqual(await getCreditLedgerEntries(db), []);
  });

  test("duplicate Wake-Up Calls do not duplicate execution jobs or credit debits", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 100 });
    await insertTaskRun(db, {
      id: "parent-duplicate-wake",
      nodeExecutionId: "node-execution-parent-duplicate-wake",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      estimatedCreditCost: 12,
      id: "child-duplicate-wake",
      nodeExecutionId: "node-execution-child-duplicate-wake",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-duplicate-wake",
      parentNodeExecutionId: "node-execution-parent-duplicate-wake",
    });

    await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "parent-duplicate-wake",
    });
    const duplicate = await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "parent-duplicate-wake",
    });

    assert.deepEqual(duplicate, { executionJobs: [], taskStatusEvents: [] });
    assert.equal(await getUserCreditBalance(db, "owner-user"), 88);
    assert.equal((await getCreditLedgerEntries(db)).length, 1);
  });

  test("stale Wake-Up Calls after a child is already Queued return no job and no second ledger debit", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 88 });
    await insertTaskRun(db, {
      id: "parent-stale-wake",
      nodeExecutionId: "node-execution-parent-stale-wake",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      estimatedCreditCost: 12,
      id: "child-stale-wake",
      nodeExecutionId: "node-execution-child-stale-wake",
      reservedCredits: 12,
      runtimeStatus: "QUEUED",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-stale-wake",
      parentNodeExecutionId: "node-execution-parent-stale-wake",
    });
    await insertTaskRunDebitLedgerEntry(db, {
      amount: 12,
      balanceAfter: 88,
      taskRunId: "child-stale-wake",
    });

    const result = await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "parent-stale-wake",
    });

    assert.deepEqual(result, { executionJobs: [], taskStatusEvents: [] });
    assert.equal(await getUserCreditBalance(db, "owner-user"), 88);
    assert.deepEqual(await getCreditLedgerEntries(db), [
      {
        amount: 12,
        balanceAfter: 88,
        kind: "debit",
        sourceKey: "task_run:child-stale-wake:debit",
        userId: "owner-user",
      },
    ]);
  });

  test("stale Wake-Up Calls queue waiting children against the latest Approved Attempt", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 100 });
    await insertTaskRun(db, {
      id: "parent-stale-approved-before-latest",
      nodeExecutionId: "node-execution-parent-stale-latest",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      attempt: 1,
      id: "parent-latest-approved-after-stale",
      nodeExecutionId: "node-execution-parent-stale-latest",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "asset-parent-latest-approved-after-stale",
      taskRunId: "parent-latest-approved-after-stale",
      text: "latest approved text",
    });
    await insertTaskRun(db, {
      estimatedCreditCost: 7,
      id: "child-stale-approved-wake",
      nodeExecutionId: "node-execution-child-stale-approved-wake",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-stale-approved-wake",
      parentNodeExecutionId: "node-execution-parent-stale-latest",
      parentNodeId: "parent-node",
      targetNodeId: "child-node",
    });

    const result = await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "parent-stale-approved-before-latest",
    });

    assert.deepEqual(result.executionJobs, [
      {
        attempt: 0,
        itemIndex: 0,
        jobId: "task-run~child-stale-approved-wake~attempt~0~execute",
        nodeExecutionId: "node-execution-child-stale-approved-wake",
        ownerUserId: "owner-user",
        taskRunId: "child-stale-approved-wake",
        workflowId: "workflow-id",
      },
    ]);
    assert.deepEqual(result.taskStatusEvents, [
      {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-child-stale-approved-wake",
        status: "QUEUED",
        taskRunId: "child-stale-approved-wake",
      },
    ]);
    assert.deepEqual(
      await repository.getTaskDependenciesForChild({
        childTaskRunId: "child-stale-approved-wake",
      }),
      [
        {
          childTaskRunId: "child-stale-approved-wake",
          requiredParentItemIndex: 0,
          requiredParentNodeId: "parent-node",
          requiredParentNodeExecutionId: "node-execution-parent-stale-latest",
          resolvedParentTaskRunId: "parent-latest-approved-after-stale",
          sourceHandle: null,
          targetHandle: null,
          targetNodeId: "child-node",
        },
      ],
    );
    assert.deepEqual(
      await getWakeUpTaskRunState(db, "child-stale-approved-wake"),
      {
        error: null,
        inputSnapshot: {
          ...inputSnapshot("child-stale-approved-wake", 0, {
            nodeExecutionId: "node-execution-child-stale-approved-wake",
          }),
          providerInput: {
            kind: "llm-generation-request",
            request: {
              idempotencyKey: "task_run:child-stale-approved-wake:attempt:0",
              maxOutputTokens: 2048,
              mode: null,
              model: "gemini-3-flash-preview",
              prompt: "latest approved text",
              referenceImages: [],
              systemPrompt: null,
              temperature: 1,
              thinkingLevel: "LOW",
            },
          },
          resolvedParentTaskRuns: [
            {
              address: {
                parentItemIndex: 0,
                parentNodeId: "parent-node",
                sourceHandle: null,
                targetHandle: null,
                targetNodeId: "child-node",
              },
              attempt: 1,
              itemIndex: 0,
              nodeExecutionId: "node-execution-parent-stale-latest",
              output: {
                assetId: "asset-parent-latest-approved-after-stale",
                kind: "inline-text-asset",
                text: "latest approved text",
              },
              taskRunId: "parent-latest-approved-after-stale",
            },
          ],
        },
        reservedCredits: 7,
        runtimeStatus: "QUEUED",
      },
    );
    assert.equal(await getUserCreditBalance(db, "owner-user"), 93);
    assert.equal((await getCreditLedgerEntries(db)).length, 1);
  });

  test("stale Wake-Up Calls cascade waiting children from the latest Failed Attempt", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 100 });
    await insertTaskRun(db, {
      id: "parent-approved-before-failed-latest",
      nodeExecutionId: "node-execution-parent-stale-failed",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      attempt: 1,
      id: "parent-failed-after-approved-stale",
      nodeExecutionId: "node-execution-parent-stale-failed",
      runtimeStatus: "FAILED",
    });
    await insertTaskRun(db, {
      id: "child-stale-failed-wake",
      nodeExecutionId: "node-execution-child-stale-failed-wake",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-stale-failed-wake",
      parentNodeExecutionId: "node-execution-parent-stale-failed",
    });

    const result = await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "parent-approved-before-failed-latest",
    });

    assert.deepEqual(result.executionJobs, []);
    assert.deepEqual(result.taskStatusEvents, [
      {
        attempt: 0,
        failureReason: "UPSTREAM_FAILED",
        itemIndex: 0,
        nodeExecutionId: "node-execution-child-stale-failed-wake",
        status: "UPSTREAM_FAILED",
        taskRunId: "child-stale-failed-wake",
      },
    ]);
    assert.deepEqual(
      await getWakeUpTaskRunState(db, "child-stale-failed-wake"),
      {
        error: "parent-failed-after-approved-stale",
        inputSnapshot: inputSnapshot("child-stale-failed-wake", 0, {
          nodeExecutionId: "node-execution-child-stale-failed-wake",
        }),
        reservedCredits: null,
        runtimeStatus: "UPSTREAM_FAILED",
      },
    );
    assert.equal(await getUserCreditBalance(db, "owner-user"), 100);
    assert.deepEqual(await getCreditLedgerEntries(db), []);
  });

  test("Wake-Up Calls persist resolved parent Task Run identities", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 100 });
    await insertTaskRun(db, {
      id: "parent-old-approved",
      nodeExecutionId: "node-execution-parent-resolution",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      attempt: 1,
      id: "parent-latest-approved",
      nodeExecutionId: "node-execution-parent-resolution",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      estimatedCreditCost: 1,
      id: "child-resolution",
      nodeExecutionId: "node-execution-child-resolution",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-resolution",
      parentNodeExecutionId: "node-execution-parent-resolution",
    });

    await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "parent-latest-approved",
    });

    assert.deepEqual(
      await repository.getTaskDependenciesForChild({
        childTaskRunId: "child-resolution",
      }),
      [
        {
          childTaskRunId: "child-resolution",
          requiredParentItemIndex: 0,
          requiredParentNodeId: "node-id",
          requiredParentNodeExecutionId: "node-execution-parent-resolution",
          resolvedParentTaskRunId: "parent-latest-approved",
          sourceHandle: null,
          targetHandle: null,
          targetNodeId: "node-id",
        },
      ],
    );
  });

  test("regenerated parent Attempts satisfy unresolved downstream dependencies without rewriting queued children", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    const childNodeConfig = {
      ...createWorkflowNode("llmGenerator", 0),
      id: "child-node",
      label: "Child Script",
    };
    await insertUser(db, { creditBalance: 100 });
    await insertTaskRun(db, {
      attempt: 0,
      id: "parent-before-regeneration",
      nodeExecutionId: "node-execution-parent-regenerated-slot",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "asset-parent-before-regeneration",
      taskRunId: "parent-before-regeneration",
      text: "old parent output",
    });

    await repository.commitWorkflowRunPlan(
      workflowRunPlan({
        nodeExecutionsToCreate: [
          {
            id: "node-execution-child-already-queued",
            nodeId: "child-node",
            ownerId: "owner-user",
            workflowId: "workflow-id",
          },
        ],
        nodeExecutionsToReuse: [
          {
            id: "node-execution-parent-regenerated-slot",
            nodeId: "parent-node",
          },
        ],
        taskDependenciesToCreate: [
          {
            childNodeExecutionId: "node-execution-child-already-queued",
            childNodeId: "child-node",
            childTaskRunId: "child-already-queued",
            parentItemIndex: 0,
            parentNodeExecutionId: "node-execution-parent-regenerated-slot",
            parentNodeId: "parent-node",
            sourceHandle: "text",
            targetHandle: "prompt",
            targetNodeId: "child-node",
          },
        ],
        taskRunsToCreate: [
          {
            attempt: 0,
            creditCost: 0,
            id: "child-already-queued",
            itemIndex: 0,
            nodeExecutionId: "node-execution-child-already-queued",
            nodeId: "child-node",
            status: "QUEUED",
            targetNodeConfig: childNodeConfig,
          },
        ],
      }),
    );
    await insertTaskRun(db, {
      estimatedCreditCost: 1,
      id: "child-waiting-for-regeneration",
      inputSnapshot: inputSnapshot("child-waiting-for-regeneration", 0, {
        nodeExecutionId: "node-execution-child-waiting-regeneration",
        nodeId: "child-node",
        targetNodeConfig: childNodeConfig,
      }),
      nodeId: "child-node",
      nodeExecutionId: "node-execution-child-waiting-regeneration",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-waiting-for-regeneration",
      parentNodeExecutionId: "node-execution-parent-regenerated-slot",
      parentNodeId: "parent-node",
      sourceHandle: "text",
      targetHandle: "prompt",
      targetNodeId: "child-node",
    });
    await insertTaskRun(db, {
      attempt: 1,
      id: "parent-regenerated-approved",
      nodeExecutionId: "node-execution-parent-regenerated-slot",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "asset-parent-regenerated-approved",
      taskRunId: "parent-regenerated-approved",
      text: "regenerated parent output",
    });

    const result = await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "parent-regenerated-approved",
    });

    assert.deepEqual(result.executionJobs, [
      {
        attempt: 0,
        itemIndex: 0,
        jobId: "task-run~child-waiting-for-regeneration~attempt~0~execute",
        nodeExecutionId: "node-execution-child-waiting-regeneration",
        ownerUserId: "owner-user",
        taskRunId: "child-waiting-for-regeneration",
        workflowId: "workflow-id",
      },
    ]);
    assert.deepEqual(
      await repository.getTaskDependenciesForChild({
        childTaskRunId: "child-already-queued",
      }),
      [
        {
          childTaskRunId: "child-already-queued",
          requiredParentItemIndex: 0,
          requiredParentNodeId: "parent-node",
          requiredParentNodeExecutionId:
            "node-execution-parent-regenerated-slot",
          resolvedParentTaskRunId: "parent-before-regeneration",
          sourceHandle: "text",
          targetHandle: "prompt",
          targetNodeId: "child-node",
        },
      ],
    );
    assert.deepEqual(
      await repository.getTaskDependenciesForChild({
        childTaskRunId: "child-waiting-for-regeneration",
      }),
      [
        {
          childTaskRunId: "child-waiting-for-regeneration",
          requiredParentItemIndex: 0,
          requiredParentNodeId: "parent-node",
          requiredParentNodeExecutionId:
            "node-execution-parent-regenerated-slot",
          resolvedParentTaskRunId: "parent-regenerated-approved",
          sourceHandle: "text",
          targetHandle: "prompt",
          targetNodeId: "child-node",
        },
      ],
    );
    assert.deepEqual(
      await getWakeUpTaskRunState(db, "child-waiting-for-regeneration"),
      {
        error: null,
        inputSnapshot: {
          ...inputSnapshot("child-waiting-for-regeneration", 0, {
            nodeExecutionId: "node-execution-child-waiting-regeneration",
            nodeId: "child-node",
            targetNodeConfig: childNodeConfig,
          }),
          providerInput: {
            kind: "llm-generation-request",
            request: {
              idempotencyKey:
                "task_run:child-waiting-for-regeneration:attempt:0",
              maxOutputTokens: 2048,
              mode: null,
              model: "gemini-3-flash-preview",
              prompt: "regenerated parent output",
              referenceImages: [],
              systemPrompt: null,
              temperature: 1,
              thinkingLevel: "LOW",
            },
          },
          resolvedParentTaskRuns: [
            {
              address: {
                parentItemIndex: 0,
                parentNodeId: "parent-node",
                sourceHandle: "text",
                targetHandle: "prompt",
                targetNodeId: "child-node",
              },
              attempt: 1,
              itemIndex: 0,
              nodeExecutionId: "node-execution-parent-regenerated-slot",
              output: {
                assetId: "asset-parent-regenerated-approved",
                kind: "inline-text-asset",
                text: "regenerated parent output",
              },
              taskRunId: "parent-regenerated-approved",
            },
          ],
        },
        reservedCredits: 1,
        runtimeStatus: "QUEUED",
      },
    );
  });

  test("transactionally persists planned Node Executions and queued Task Runs", async () => {
    const repository = createWorkflowRuntimeRepository(db);

    const result = await repository.commitWorkflowRunPlan(
      workflowRunPlan({
        nodeExecutionsToCreate: [
          {
            id: "node-execution-source",
            nodeId: "source-node",
            ownerId: "owner-user",
            workflowId: "workflow-id",
          },
        ],
        taskRunsToCreate: [
          {
            attempt: 0,
            creditCost: 0,
            id: "task-run-source-0",
            itemIndex: 0,
            nodeExecutionId: "node-execution-source",
            nodeId: "source-node",
            status: "QUEUED",
          },
          {
            attempt: 0,
            creditCost: 0,
            id: "task-run-source-1",
            itemIndex: 1,
            nodeExecutionId: "node-execution-source",
            nodeId: "source-node",
            status: "QUEUED",
          },
        ],
      }),
    );

    assert.deepEqual(result, {
      executionJobs: [
        {
          attempt: 0,
          itemIndex: 0,
          jobId: "task-run~task-run-source-0~attempt~0~execute",
          nodeExecutionId: "node-execution-source",
          ownerUserId: "owner-user",
          taskRunId: "task-run-source-0",
          workflowId: "workflow-id",
        },
        {
          attempt: 0,
          itemIndex: 1,
          jobId: "task-run~task-run-source-1~attempt~0~execute",
          nodeExecutionId: "node-execution-source",
          ownerUserId: "owner-user",
          taskRunId: "task-run-source-1",
          workflowId: "workflow-id",
        },
      ],
      taskStatusEvents: [
        {
          attempt: 0,
          itemIndex: 0,
          nodeExecutionId: "node-execution-source",
          status: "QUEUED",
          taskRunId: "task-run-source-0",
        },
        {
          attempt: 0,
          itemIndex: 1,
          nodeExecutionId: "node-execution-source",
          status: "QUEUED",
          taskRunId: "task-run-source-1",
        },
      ],
      wakeUpJobs: [],
    });
    assert.deepEqual(
      await repository.getRuntimeTaskRunsForNodeExecution({
        nodeExecutionId: "node-execution-source",
      }),
      [
        {
          attempt: 0,
          inputSnapshot: inputSnapshot("task-run-source-0", 0, {
            nodeExecutionId: "node-execution-source",
            nodeId: "source-node",
          }),
          itemIndex: 0,
          nodeExecutionId: "node-execution-source",
          ownerUserId: "owner-user",
          reservedCredits: 0,
          runtimeStatus: "QUEUED",
          taskRunId: "task-run-source-0",
          workflowId: "workflow-id",
        },
        {
          attempt: 0,
          inputSnapshot: inputSnapshot("task-run-source-1", 0, {
            itemIndex: 1,
            nodeExecutionId: "node-execution-source",
            nodeId: "source-node",
          }),
          itemIndex: 1,
          nodeExecutionId: "node-execution-source",
          ownerUserId: "owner-user",
          reservedCredits: 0,
          runtimeStatus: "QUEUED",
          taskRunId: "task-run-source-1",
          workflowId: "workflow-id",
        },
      ],
    );
    assert.deepEqual(
      await repository.claimQueuedTaskRun({
        attempt: 0,
        ownerUserId: "owner-user",
        taskRunId: "task-run-source-0",
      }),
      {
        claimed: true,
        event: {
          attempt: 0,
          itemIndex: 0,
          nodeExecutionId: "node-execution-source",
          status: "RUNNING",
          taskRunId: "task-run-source-0",
        },
        inputSnapshot: inputSnapshot("task-run-source-0", 0, {
          nodeExecutionId: "node-execution-source",
          nodeId: "source-node",
        }),
      },
    );
  });

  test("committing a regeneration plan preserves historical Attempt snapshots and inserts a new materialized snapshot", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    const historicalSnapshot = {
      ...inputSnapshot("task-run-historical", 2, {
        nodeExecutionId: "node-execution-regenerate-existing",
        nodeId: "script-node",
      }),
      providerInput: {
        kind: "llm-generation-request",
        request: {
          idempotencyKey: "task_run:task-run-historical:attempt:2",
          maxOutputTokens: 2048,
          mode: null,
          model: "gemini-3-flash-preview",
          prompt: "historical frozen prompt",
          referenceImages: [],
          systemPrompt: null,
          temperature: 1,
          thinkingLevel: "LOW",
        },
      },
    } satisfies TaskRunInputSnapshot;
    const regeneratedSnapshot = {
      ...inputSnapshot("task-run-regenerated", 3, {
        nodeExecutionId: "node-execution-regenerate-existing",
        nodeId: "script-node",
      }),
      providerInput: {
        kind: "llm-generation-request",
        request: {
          idempotencyKey: "task_run:task-run-regenerated:attempt:3",
          maxOutputTokens: 2048,
          mode: null,
          model: "gemini-3-flash-preview",
          prompt: "current regenerated prompt",
          referenceImages: [],
          systemPrompt: null,
          temperature: 1,
          thinkingLevel: "LOW",
        },
      },
    } satisfies TaskRunInputSnapshot;
    await insertTaskRun(db, {
      attempt: 2,
      id: "task-run-historical",
      inputSnapshot: historicalSnapshot,
      nodeExecutionId: "node-execution-regenerate-existing",
      nodeId: "script-node",
      runtimeStatus: "APPROVED",
    });

    await repository.commitWorkflowRunPlan(
      workflowRunPlan({
        nodeExecutionsToReuse: [
          {
            id: "node-execution-regenerate-existing",
            nodeId: "script-node",
          },
        ],
        taskRunsToCreate: [
          {
            attempt: 3,
            creditCost: 0,
            id: "task-run-regenerated",
            inputSnapshot: regeneratedSnapshot,
            itemIndex: 0,
            nodeExecutionId: "node-execution-regenerate-existing",
            nodeId: "script-node",
            status: "QUEUED",
            targetNodeConfig: regeneratedSnapshot.targetNodeConfig,
          },
        ],
      }),
    );

    assert.deepEqual(
      await repository.getRuntimeTaskRunsForNodeExecution({
        nodeExecutionId: "node-execution-regenerate-existing",
      }),
      [
        {
          attempt: 2,
          inputSnapshot: historicalSnapshot,
          itemIndex: 0,
          nodeExecutionId: "node-execution-regenerate-existing",
          ownerUserId: "owner-user",
          reservedCredits: null,
          runtimeStatus: "APPROVED",
          taskRunId: "task-run-historical",
          workflowId: "workflow-id",
        },
        {
          attempt: 3,
          inputSnapshot: regeneratedSnapshot,
          itemIndex: 0,
          nodeExecutionId: "node-execution-regenerate-existing",
          ownerUserId: "owner-user",
          reservedCredits: 0,
          runtimeStatus: "QUEUED",
          taskRunId: "task-run-regenerated",
          workflowId: "workflow-id",
        },
      ],
    );
  });

  test("persists the planned immutable input snapshot before a Task Run becomes Queued", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    const frozenSnapshot = {
      ...inputSnapshot("task-run-frozen", 0, {
        nodeExecutionId: "node-execution-frozen",
        nodeId: "frozen-node",
      }),
      documentRevision: 88,
      providerInput: {
        kind: "llm-generation-request" as const,
        request: {
          idempotencyKey: "task_run:task-run-frozen:attempt:0",
          maxOutputTokens: 1024,
          mode: null,
          model: "gemini-3-flash-preview" as const,
          prompt: "frozen provider prompt",
          referenceImages: [],
          systemPrompt: null,
          temperature: 0.2,
          thinkingLevel: "LOW" as const,
        },
      },
    };
    const liveTargetNodeConfig = {
      ...frozenSnapshot.targetNodeConfig,
      config: { temperature: 1 },
    };

    await repository.commitWorkflowRunPlan(
      workflowRunPlan({
        nodeExecutionsToCreate: [
          {
            id: "node-execution-frozen",
            nodeId: "frozen-node",
            ownerId: "owner-user",
            workflowId: "workflow-id",
          },
        ],
        taskRunsToCreate: [
          {
            attempt: 0,
            creditCost: 0,
            id: "task-run-frozen",
            inputSnapshot: frozenSnapshot,
            itemIndex: 0,
            nodeExecutionId: "node-execution-frozen",
            nodeId: "frozen-node",
            status: "QUEUED",
            targetNodeConfig: liveTargetNodeConfig,
          },
        ],
      }),
    );

    assert.deepEqual(
      await repository.claimQueuedTaskRun({
        attempt: 0,
        ownerUserId: "owner-user",
        taskRunId: "task-run-frozen",
      }),
      {
        claimed: true,
        event: {
          attempt: 0,
          itemIndex: 0,
          nodeExecutionId: "node-execution-frozen",
          status: "RUNNING",
          taskRunId: "task-run-frozen",
        },
        inputSnapshot: frozenSnapshot,
      },
    );
  });

  test("marks unsupported planned node kinds failed and does not enqueue them", async () => {
    const repository = createWorkflowRuntimeRepository(db);

    const result = await repository.commitWorkflowRunPlan(
      workflowRunPlan({
        nodeExecutionsToCreate: [
          {
            id: "node-execution-list",
            nodeId: "list-node",
            ownerId: "owner-user",
            workflowId: "workflow-id",
          },
        ],
        taskRunsToCreate: [
          {
            attempt: 0,
            creditCost: 0,
            id: "task-run-list",
            itemIndex: 0,
            nodeExecutionId: "node-execution-list",
            nodeId: "list-node",
            status: "QUEUED",
            targetNodeConfig: {
              ...createWorkflowNode("list", 0),
              id: "list-node",
            },
          },
        ],
      }),
    );

    assert.deepEqual(result.executionJobs, []);
    assert.deepEqual(result.taskStatusEvents, [
      {
        attempt: 0,
        failureReason: "EXECUTION_FAILED",
        itemIndex: 0,
        nodeExecutionId: "node-execution-list",
        status: "FAILED",
        taskRunId: "task-run-list",
      },
    ]);
    assert.deepEqual(await getTaskRunCreditState(db, "task-run-list"), {
      estimatedCreditCost: 0,
      failureReason: "EXECUTION_FAILED",
      reservedCredits: null,
      runtimeStatus: "FAILED",
    });
  });

  test("reserves estimated credits for funded initially Queued Task Runs", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 50 });

    const result = await repository.commitWorkflowRunPlan(
      workflowRunPlan({
        nodeExecutionsToCreate: [
          {
            id: "node-execution-funded-source",
            nodeId: "source-node",
            ownerId: "owner-user",
            workflowId: "workflow-id",
          },
        ],
        taskRunsToCreate: [
          {
            attempt: 0,
            creditCost: 12,
            id: "task-run-funded-source",
            itemIndex: 0,
            nodeExecutionId: "node-execution-funded-source",
            nodeId: "source-node",
            status: "QUEUED",
          },
        ],
      }),
    );

    assert.deepEqual(result.executionJobs, [
      {
        attempt: 0,
        itemIndex: 0,
        jobId: "task-run~task-run-funded-source~attempt~0~execute",
        nodeExecutionId: "node-execution-funded-source",
        ownerUserId: "owner-user",
        taskRunId: "task-run-funded-source",
        workflowId: "workflow-id",
      },
    ]);
    assert.deepEqual(
      await getTaskRunCreditState(db, "task-run-funded-source"),
      {
        estimatedCreditCost: 12,
        failureReason: null,
        reservedCredits: 12,
        runtimeStatus: "QUEUED",
      },
    );
    assert.equal(await getUserCreditBalance(db, "owner-user"), 38);
    assert.deepEqual(await getCreditLedgerEntries(db), [
      {
        amount: 12,
        balanceAfter: 38,
        kind: "debit",
        sourceKey: "task_run:task-run-funded-source:debit",
        userId: "owner-user",
      },
    ]);
  });

  test("fails unfunded initially Queued Task Runs without returning execution jobs", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertUser(db, { creditBalance: 5 });

    const result = await repository.commitWorkflowRunPlan(
      workflowRunPlan({
        nodeExecutionsToCreate: [
          {
            id: "node-execution-unfunded-source",
            nodeId: "source-node",
            ownerId: "owner-user",
            workflowId: "workflow-id",
          },
        ],
        taskRunsToCreate: [
          {
            attempt: 0,
            creditCost: 9,
            id: "task-run-unfunded-source",
            itemIndex: 0,
            nodeExecutionId: "node-execution-unfunded-source",
            nodeId: "source-node",
            status: "QUEUED",
          },
        ],
      }),
    );

    assert.deepEqual(result, {
      executionJobs: [],
      taskStatusEvents: [
        {
          attempt: 0,
          failureReason: "INSUFFICIENT_CREDITS",
          itemIndex: 0,
          nodeExecutionId: "node-execution-unfunded-source",
          status: "FAILED",
          taskRunId: "task-run-unfunded-source",
        },
      ],
      wakeUpJobs: [
        {
          jobId: "wake-up~task-run-unfunded-source",
          ownerUserId: "owner-user",
          parentTaskRunId: "task-run-unfunded-source",
          workflowId: "workflow-id",
        },
      ],
    });
    assert.deepEqual(
      await getTaskRunCreditState(db, "task-run-unfunded-source"),
      {
        estimatedCreditCost: 9,
        failureReason: "INSUFFICIENT_CREDITS",
        reservedCredits: null,
        runtimeStatus: "FAILED",
      },
    );
    assert.equal(await getUserCreditBalance(db, "owner-user"), 5);
    assert.deepEqual(await getCreditLedgerEntries(db), []);
  });

  test("freezes dependencies for planned Queued Task Runs against latest Approved parent Task Runs", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    const childNodeConfig = {
      ...createWorkflowNode("llmGenerator", 0),
      id: "child-node",
      label: "Child Script",
    };
    await insertTaskRun(db, {
      attempt: 0,
      id: "parent-old-approved-for-commit",
      nodeExecutionId: "node-execution-parent-for-commit",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      attempt: 1,
      id: "parent-latest-approved-for-commit",
      nodeExecutionId: "node-execution-parent-for-commit",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "asset-parent-latest-approved-for-commit",
      taskRunId: "parent-latest-approved-for-commit",
      text: "approved parent output",
    });

    const result = await repository.commitWorkflowRunPlan(
      workflowRunPlan({
        nodeExecutionsToCreate: [
          {
            id: "node-execution-child-commit-ready",
            nodeId: "child-node",
            ownerId: "owner-user",
            workflowId: "workflow-id",
          },
        ],
        nodeExecutionsToReuse: [
          { id: "node-execution-parent-for-commit", nodeId: "parent-node" },
        ],
        taskDependenciesToCreate: [
          {
            childNodeExecutionId: "node-execution-child-commit-ready",
            childNodeId: "child-node",
            childTaskRunId: "task-run-child-commit-ready",
            parentItemIndex: 0,
            parentNodeExecutionId: "node-execution-parent-for-commit",
            parentNodeId: "parent-node",
            sourceHandle: "text",
            targetHandle: "prompt",
            targetNodeId: "child-node",
          },
        ],
        taskRunsToCreate: [
          {
            attempt: 0,
            creditCost: 0,
            id: "task-run-child-commit-ready",
            itemIndex: 0,
            nodeExecutionId: "node-execution-child-commit-ready",
            nodeId: "child-node",
            status: "QUEUED",
            targetNodeConfig: childNodeConfig,
          },
        ],
      }),
    );

    assert.deepEqual(result.executionJobs, [
      {
        attempt: 0,
        itemIndex: 0,
        jobId: "task-run~task-run-child-commit-ready~attempt~0~execute",
        nodeExecutionId: "node-execution-child-commit-ready",
        ownerUserId: "owner-user",
        taskRunId: "task-run-child-commit-ready",
        workflowId: "workflow-id",
      },
    ]);
    assert.deepEqual(
      await repository.getRuntimeTaskRunsForNodeExecution({
        nodeExecutionId: "node-execution-child-commit-ready",
      }),
      [
        {
          attempt: 0,
          inputSnapshot: {
            ...inputSnapshot("task-run-child-commit-ready", 0, {
              nodeExecutionId: "node-execution-child-commit-ready",
              nodeId: "child-node",
              targetNodeConfig: childNodeConfig,
            }),
            providerInput: {
              kind: "llm-generation-request",
              request: {
                idempotencyKey:
                  "task_run:task-run-child-commit-ready:attempt:0",
                maxOutputTokens: 2048,
                mode: null,
                model: "gemini-3-flash-preview",
                prompt: "approved parent output",
                referenceImages: [],
                systemPrompt: null,
                temperature: 1,
                thinkingLevel: "LOW",
              },
            },
            resolvedParentTaskRuns: [
              {
                address: {
                  parentItemIndex: 0,
                  parentNodeId: "parent-node",
                  sourceHandle: "text",
                  targetHandle: "prompt",
                  targetNodeId: "child-node",
                },
                attempt: 1,
                itemIndex: 0,
                nodeExecutionId: "node-execution-parent-for-commit",
                output: {
                  assetId: "asset-parent-latest-approved-for-commit",
                  kind: "inline-text-asset",
                  text: "approved parent output",
                },
                taskRunId: "parent-latest-approved-for-commit",
              },
            ],
          },
          itemIndex: 0,
          nodeExecutionId: "node-execution-child-commit-ready",
          ownerUserId: "owner-user",
          reservedCredits: 0,
          runtimeStatus: "QUEUED",
          taskRunId: "task-run-child-commit-ready",
          workflowId: "workflow-id",
        },
      ],
    );
    assert.deepEqual(
      await repository.getTaskDependenciesForChild({
        childTaskRunId: "task-run-child-commit-ready",
      }),
      [
        {
          childTaskRunId: "task-run-child-commit-ready",
          requiredParentItemIndex: 0,
          requiredParentNodeId: "parent-node",
          requiredParentNodeExecutionId: "node-execution-parent-for-commit",
          resolvedParentTaskRunId: "parent-latest-approved-for-commit",
          sourceHandle: "text",
          targetHandle: "prompt",
          targetNodeId: "child-node",
        },
      ],
    );
    assert.equal(
      await getTaskDependencyResolvedAtIsSet(db, "task-run-child-commit-ready"),
      true,
    );
    const claimed = await repository.claimQueuedTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "task-run-child-commit-ready",
    });
    assert.equal(claimed.claimed, true);
    if (claimed.claimed) {
      assert.deepEqual(claimed.inputSnapshot.targetNodeConfig, childNodeConfig);
      assert.deepEqual(
        claimed.inputSnapshot.resolvedParentTaskRuns[0]?.output,
        {
          assetId: "asset-parent-latest-approved-for-commit",
          kind: "inline-text-asset",
          text: "approved parent output",
        },
      );
    }
  });

  test("rejects a plan that would queue a child whose latest parent Task Run is not Approved", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertTaskRun(db, {
      attempt: 0,
      id: "parent-approved-stale-for-commit",
      nodeExecutionId: "node-execution-parent-stale-for-commit",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      attempt: 1,
      id: "parent-pending-latest-for-commit",
      nodeExecutionId: "node-execution-parent-stale-for-commit",
      runtimeStatus: "PENDING_REVIEW",
    });

    await assert.rejects(() =>
      repository.commitWorkflowRunPlan(
        workflowRunPlan({
          nodeExecutionsToCreate: [
            {
              id: "node-execution-child-unsafe-commit",
              nodeId: "child-node",
              ownerId: "owner-user",
              workflowId: "workflow-id",
            },
          ],
          nodeExecutionsToReuse: [
            {
              id: "node-execution-parent-stale-for-commit",
              nodeId: "parent-node",
            },
          ],
          taskDependenciesToCreate: [
            {
              childNodeExecutionId: "node-execution-child-unsafe-commit",
              childNodeId: "child-node",
              childTaskRunId: "task-run-child-unsafe-commit",
              parentItemIndex: 0,
              parentNodeExecutionId: "node-execution-parent-stale-for-commit",
              parentNodeId: "parent-node",
              targetNodeId: "child-node",
            },
          ],
          taskRunsToCreate: [
            {
              attempt: 0,
              creditCost: 0,
              id: "task-run-child-unsafe-commit",
              itemIndex: 0,
              nodeExecutionId: "node-execution-child-unsafe-commit",
              nodeId: "child-node",
              status: "QUEUED",
            },
          ],
        }),
      ),
    );
    assert.deepEqual(
      await repository.getRuntimeTaskRunsForNodeExecution({
        nodeExecutionId: "node-execution-child-unsafe-commit",
      }),
      [],
    );
  });

  test("persists Waiting Upstream Task Runs without execution jobs", async () => {
    const repository = createWorkflowRuntimeRepository(db);

    const result = await repository.commitWorkflowRunPlan(
      workflowRunPlan({
        nodeExecutionsToCreate: [
          {
            id: "node-execution-child",
            nodeId: "child-node",
            ownerId: "owner-user",
            workflowId: "workflow-id",
          },
        ],
        taskRunsToCreate: [
          {
            attempt: 0,
            creditCost: 7,
            id: "task-run-child-0",
            itemIndex: 0,
            nodeExecutionId: "node-execution-child",
            nodeId: "child-node",
            status: "WAITING_UPSTREAM",
          },
        ],
      }),
    );

    assert.deepEqual(result, {
      executionJobs: [],
      taskStatusEvents: [
        {
          attempt: 0,
          itemIndex: 0,
          nodeExecutionId: "node-execution-child",
          status: "WAITING_UPSTREAM",
          taskRunId: "task-run-child-0",
        },
      ],
      wakeUpJobs: [],
    });
    assert.deepEqual(
      await repository.getRuntimeTaskRunsForNodeExecution({
        nodeExecutionId: "node-execution-child",
      }),
      [
        {
          attempt: 0,
          inputSnapshot: inputSnapshot("task-run-child-0", 0, {
            nodeExecutionId: "node-execution-child",
            nodeId: "child-node",
          }),
          itemIndex: 0,
          nodeExecutionId: "node-execution-child",
          ownerUserId: "owner-user",
          reservedCredits: null,
          runtimeStatus: "WAITING_UPSTREAM",
          taskRunId: "task-run-child-0",
          workflowId: "workflow-id",
        },
      ],
    );
    assert.deepEqual(await getTaskRunCreditState(db, "task-run-child-0"), {
      estimatedCreditCost: 7,
      failureReason: null,
      reservedCredits: null,
      runtimeStatus: "WAITING_UPSTREAM",
    });
  });

  test("persists the planned immutable input snapshot for Waiting Upstream Task Runs", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    const frozenTargetNodeConfig = defaultTargetNodeConfig("waiting-node");
    const frozenSnapshot = {
      ...inputSnapshot("task-run-waiting-frozen", 0, {
        nodeExecutionId: "node-execution-waiting-frozen",
        nodeId: "waiting-node",
        targetNodeConfig: frozenTargetNodeConfig,
      }),
      documentRevision: 91,
      providerInput: {
        kind: "llm-generation-request" as const,
        request: {
          idempotencyKey: "task_run:task-run-waiting-frozen:attempt:0",
          maxOutputTokens: 512,
          mode: null,
          model: "gemini-3-flash-preview" as const,
          prompt: "frozen waiting prompt",
          referenceImages: [],
          systemPrompt: "frozen system prompt",
          temperature: 0.4,
          thinkingLevel: "LOW" as const,
        },
      },
    };

    await repository.commitWorkflowRunPlan(
      workflowRunPlan({
        nodeExecutionsToCreate: [
          {
            id: "node-execution-waiting-frozen",
            nodeId: "waiting-node",
            ownerId: "owner-user",
            workflowId: "workflow-id",
          },
        ],
        taskRunsToCreate: [
          {
            attempt: 0,
            creditCost: 7,
            id: "task-run-waiting-frozen",
            inputSnapshot: frozenSnapshot,
            itemIndex: 0,
            nodeExecutionId: "node-execution-waiting-frozen",
            nodeId: "waiting-node",
            status: "WAITING_UPSTREAM",
            targetNodeConfig: {
              ...frozenTargetNodeConfig,
              config: { temperature: 1.8 },
            },
          },
        ],
      }),
    );

    assert.deepEqual(
      await repository.getRuntimeTaskRunsForNodeExecution({
        nodeExecutionId: "node-execution-waiting-frozen",
      }),
      [
        {
          attempt: 0,
          inputSnapshot: frozenSnapshot,
          itemIndex: 0,
          nodeExecutionId: "node-execution-waiting-frozen",
          ownerUserId: "owner-user",
          reservedCredits: null,
          runtimeStatus: "WAITING_UPSTREAM",
          taskRunId: "task-run-waiting-frozen",
          workflowId: "workflow-id",
        },
      ],
    );
  });

  test("persists planned Task Dependencies as unresolved child requirements", async () => {
    const repository = createWorkflowRuntimeRepository(db);

    await repository.commitWorkflowRunPlan(
      workflowRunPlan({
        nodeExecutionsToCreate: [
          {
            id: "node-execution-parent",
            nodeId: "parent-node",
            ownerId: "owner-user",
            workflowId: "workflow-id",
          },
          {
            id: "node-execution-child-with-parent",
            nodeId: "child-node",
            ownerId: "owner-user",
            workflowId: "workflow-id",
          },
        ],
        taskDependenciesToCreate: [
          {
            childNodeExecutionId: "node-execution-child-with-parent",
            childNodeId: "child-node",
            childTaskRunId: "task-run-child-dependent",
            parentItemIndex: 0,
            parentNodeExecutionId: "node-execution-parent",
            parentNodeId: "parent-node",
            targetNodeId: "child-node",
          },
        ],
        taskRunsToCreate: [
          {
            attempt: 0,
            creditCost: 0,
            id: "task-run-parent-dependent",
            itemIndex: 0,
            nodeExecutionId: "node-execution-parent",
            nodeId: "parent-node",
            status: "QUEUED",
          },
          {
            attempt: 0,
            creditCost: 0,
            id: "task-run-child-dependent",
            itemIndex: 0,
            nodeExecutionId: "node-execution-child-with-parent",
            nodeId: "child-node",
            status: "WAITING_UPSTREAM",
          },
        ],
      }),
    );

    assert.deepEqual(
      await repository.getTaskDependenciesForChild({
        childTaskRunId: "task-run-child-dependent",
      }),
      [
        {
          childTaskRunId: "task-run-child-dependent",
          requiredParentItemIndex: 0,
          requiredParentNodeId: "parent-node",
          requiredParentNodeExecutionId: "node-execution-parent",
          resolvedParentTaskRunId: null,
          sourceHandle: null,
          targetHandle: null,
          targetNodeId: "child-node",
        },
      ],
    );
  });

  test("rolls back the whole plan when active slot uniqueness fails", async () => {
    const repository = createWorkflowRuntimeRepository(db);
    await insertNodeExecution(db, { id: "node-execution-existing" });
    await insertTaskRun(db, {
      id: "task-run-existing-active",
      nodeExecutionId: "node-execution-existing",
      runtimeStatus: "QUEUED",
    });

    await assert.rejects(() =>
      repository.commitWorkflowRunPlan(
        workflowRunPlan({
          nodeExecutionsToCreate: [
            {
              id: "node-execution-rolled-back",
              nodeId: "rolled-back-node",
              ownerId: "owner-user",
              workflowId: "workflow-id",
            },
          ],
          nodeExecutionsToReuse: [
            { id: "node-execution-existing", nodeId: "node-id" },
          ],
          taskRunsToCreate: [
            {
              attempt: 0,
              creditCost: 0,
              id: "task-run-would-insert-first",
              itemIndex: 0,
              nodeExecutionId: "node-execution-rolled-back",
              nodeId: "rolled-back-node",
              status: "QUEUED",
            },
            {
              attempt: 1,
              creditCost: 0,
              id: "task-run-duplicate-active-slot",
              itemIndex: 0,
              nodeExecutionId: "node-execution-existing",
              nodeId: "node-id",
              status: "QUEUED",
            },
          ],
        }),
      ),
    );
    assert.deepEqual(
      await repository.getRuntimeTaskRunsForNodeExecution({
        nodeExecutionId: "node-execution-rolled-back",
      }),
      [],
    );
  });
});

async function setupRuntimeTables(db: PgliteDatabase): Promise<void> {
  await db.execute(sql`
    create table "user" (
      id text primary key,
      name text not null,
      email text not null unique,
      credit_balance bigint not null default 0
    )
  `);
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
    create table assets (
      id text primary key,
      owner_user_id text not null,
      workflow_id text not null,
      source text not null,
      kind text not null,
      task_run_id text,
      storage_provider text not null,
      storage_key text,
      cdn_url text,
      text_content text,
      mime_type text not null,
      file_name text not null,
      size_bytes bigint not null,
      model text,
      external_uri text,
      created_at timestamp not null default now(),
      deleted_at timestamp
    )
  `);
  await db.execute(sql`
    create table node_executions (
      id text primary key,
      workflow_id text not null,
      owner_user_id text not null,
      node_id text not null,
      execution_id text not null,
      document_revision bigint,
      status text not null,
      output_count bigint not null,
      target_reason text not null,
      created_at timestamp not null default now(),
      dispatched_at timestamp,
      updated_at timestamp not null default now()
    )
  `);
  await db.execute(sql`
    create table task_runs (
      id text primary key,
      node_execution_id text not null,
      workflow_id text not null,
      owner_user_id text not null,
      node_id text not null,
      output_index bigint not null,
      version bigint not null,
      item_index bigint,
      attempt bigint,
      execution_id text not null,
      job_id text not null,
      status text not null,
      runtime_status task_run_runtime_status,
      target_reason text not null,
      asset_ids jsonb not null default '[]'::jsonb,
      input_snapshot jsonb,
      estimated_credit_cost bigint,
      reserved_credits bigint,
      failure_reason task_run_failure_reason,
      error text,
      cost_credits bigint not null default 0,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now(),
      queued_at timestamp,
      started_at timestamp,
      finished_at timestamp,
      failed_at timestamp
    )
  `);
  await db.execute(sql`
    create unique index task_runs_runtime_active_slot_unique
    on task_runs (node_execution_id, item_index)
    where runtime_status in ('WAITING_UPSTREAM', 'QUEUED', 'RUNNING', 'PENDING_REVIEW')
  `);
  await db.execute(sql`
    create table task_dependencies (
      id text primary key,
      child_task_run_id text not null,
      required_parent_node_execution_id text not null,
      required_parent_node_id text not null,
      required_parent_item_index bigint not null,
      source_handle text,
      target_handle text,
      target_node_id text not null,
      resolved_parent_task_run_id text,
      created_at timestamp not null default now(),
      resolved_at timestamp
    )
  `);
  await db.execute(sql`
    create unique index task_dependencies_child_parent_slot_unique
    on task_dependencies (
      child_task_run_id,
      required_parent_node_execution_id,
      required_parent_item_index,
      source_handle,
      target_handle
    )
  `);
  await db.execute(sql`
    create table credit_ledger_entries (
      id text primary key,
      user_id text not null,
      execution_id text,
      kind text not null,
      amount bigint not null,
      balance_after bigint not null,
      reason text not null,
      source_key text unique,
      created_at timestamp not null default now()
    )
  `);
}

async function resetRuntimeTables(db: PgliteDatabase): Promise<void> {
  await db.execute(sql`
    truncate table
      credit_ledger_entries,
      task_dependencies,
      task_runs,
      node_executions,
      assets,
      "user"
  `);
}

type InsertTaskRunInput = {
  readonly costCredits?: number;
  readonly id: string;
  readonly attempt?: number;
  readonly estimatedCreditCost?: number;
  readonly inputSnapshot?: TaskRunInputSnapshot;
  readonly nodeId?: string;
  readonly nodeExecutionId?: string;
  readonly ownerUserId?: string;
  readonly reservedCredits?: number;
  readonly runtimeStatus: TaskRunStatus;
  readonly updatedAt?: string;
};

function gatekeeperTaskRunRow(input: {
  readonly estimatedCreditCost?: number;
  readonly id: string;
  readonly inputSnapshot?: TaskRunInputSnapshot;
  readonly nodeExecutionId: string;
  readonly status: TaskRunStatus;
}) {
  return {
    attempt: 0,
    error: null,
    estimatedCreditCost: input.estimatedCreditCost ?? 0,
    failureReason: null,
    inputSnapshot: input.inputSnapshot ?? null,
    itemIndex: 0,
    nodeExecutionId: input.nodeExecutionId,
    nodeId: "node-id",
    ownerUserId: "owner-user",
    reservedCredits: null,
    status: input.status,
    taskRunId: input.id,
    workflowId: "workflow-id",
  };
}

async function insertTaskRun(
  db: PgliteDatabase,
  input: InsertTaskRunInput,
): Promise<void> {
  const attempt = input.attempt ?? 0;
  const ownerUserId = input.ownerUserId ?? "owner-user";
  const nodeExecutionId = input.nodeExecutionId ?? `node-execution-${input.id}`;
  const snapshot =
    input.inputSnapshot ??
    inputSnapshot(input.id, attempt, {
      nodeExecutionId,
      nodeId: input.nodeId ?? "node-id",
    });
  const updatedAt = input.updatedAt ?? "2026-01-01T00:00:00.000Z";

  await ensureUser(db, { id: ownerUserId });
  await insertNodeExecution(db, { id: nodeExecutionId, ownerUserId });

  await db.execute(sql`
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
      input_snapshot,
      estimated_credit_cost,
      reserved_credits,
      cost_credits,
      queued_at,
      updated_at
    ) values (
      ${input.id},
      ${nodeExecutionId},
      'workflow-id',
      ${ownerUserId},
      ${input.nodeId ?? "node-id"},
      0,
      ${attempt},
      0,
      ${attempt},
      'legacy-execution-id',
      ${`legacy-job-${input.id}`},
      'queued',
      ${input.runtimeStatus},
      'node_run',
      ${snapshot},
      ${input.estimatedCreditCost ?? 0},
      ${input.reservedCredits ?? null},
      ${input.costCredits ?? 0},
      now(),
      ${updatedAt}
    )
  `);
}

async function insertUser(
  db: PgliteDatabase,
  input: { readonly creditBalance: number; readonly id?: string },
): Promise<void> {
  const id = input.id ?? "owner-user";
  await db.execute(sql`
    insert into "user" (id, name, email, credit_balance)
    values (${id}, 'Owner User', ${`${id}@example.com`}, ${input.creditBalance})
    on conflict (id) do update set credit_balance = excluded.credit_balance
  `);
}

async function ensureUser(
  db: PgliteDatabase,
  input: { readonly id: string },
): Promise<void> {
  await db.execute(sql`
    insert into "user" (id, name, email, credit_balance)
    values (${input.id}, 'Owner User', ${`${input.id}@example.com`}, 0)
    on conflict (id) do nothing
  `);
}

async function insertTaskDependency(
  db: PgliteDatabase,
  input: {
    readonly childTaskRunId: string;
    readonly parentNodeExecutionId: string;
    readonly parentItemIndex?: number;
    readonly parentNodeId?: string;
    readonly sourceHandle?: string | null;
    readonly targetHandle?: string | null;
    readonly targetNodeId?: string;
  },
): Promise<void> {
  const parentItemIndex = input.parentItemIndex ?? 0;
  await db.execute(sql`
    insert into task_dependencies (
      id,
      child_task_run_id,
      required_parent_node_execution_id,
      required_parent_node_id,
      required_parent_item_index,
      source_handle,
      target_handle,
      target_node_id,
      resolved_parent_task_run_id
    ) values (
      ${[
        input.childTaskRunId,
        input.parentNodeExecutionId,
        parentItemIndex,
        input.sourceHandle ?? "",
        input.targetHandle ?? "",
      ].join(":")},
      ${input.childTaskRunId},
      ${input.parentNodeExecutionId},
      ${input.parentNodeId ?? "node-id"},
      ${parentItemIndex},
      ${input.sourceHandle ?? null},
      ${input.targetHandle ?? null},
      ${input.targetNodeId ?? "node-id"},
      null
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
): Promise<void> {
  await db.execute(sql`
    insert into assets (
      id,
      owner_user_id,
      workflow_id,
      source,
      kind,
      task_run_id,
      storage_provider,
      text_content,
      mime_type,
      file_name,
      size_bytes
    ) values (
      ${input.assetId},
      'owner-user',
      'workflow-id',
      'generated',
      'text',
      ${input.taskRunId},
      'inline',
      ${input.text},
      'text/plain',
      ${`${input.assetId}.txt`},
      ${input.text.length}
    )
  `);
}

async function insertGeneratedMediaAsset(
  db: PgliteDatabase,
  input: {
    readonly assetId: string;
    readonly taskRunId: string;
  },
): Promise<void> {
  await db.execute(sql`
    insert into assets (
      id,
      owner_user_id,
      workflow_id,
      source,
      kind,
      task_run_id,
      storage_provider,
      storage_key,
      cdn_url,
      mime_type,
      file_name,
      size_bytes,
      created_at
    ) values (
      ${input.assetId},
      'owner-user',
      'workflow-id',
      'generated',
      'image',
      ${input.taskRunId},
      'local',
      ${`generated/${input.assetId}.png`},
      ${`/api/assets/${input.assetId}`},
      'image/png',
      ${`${input.assetId}.png`},
      1024,
      now()
    )
  `);
}

async function insertTaskRunDebitLedgerEntry(
  db: PgliteDatabase,
  input: {
    readonly amount: number;
    readonly balanceAfter: number;
    readonly taskRunId: string;
    readonly userId?: string;
    readonly workflowId?: string;
  },
): Promise<void> {
  const sourceKey = `task_run:${input.taskRunId}:debit`;
  await db.execute(sql`
    insert into credit_ledger_entries (
      id,
      user_id,
      execution_id,
      kind,
      amount,
      balance_after,
      reason,
      source_key
    ) values (
      ${sourceKey},
      ${input.userId ?? "owner-user"},
      ${input.workflowId ?? "workflow-id"},
      'debit',
      ${input.amount},
      ${input.balanceAfter},
      'task_run_debit',
      ${sourceKey}
    )
  `);
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

function postProviderInfrastructureFailureSource() {
  return {
    taskRunDebitRefundable: false as const,
    type: "POST_PROVIDER_INFRASTRUCTURE" as const,
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

async function countAssetsForTaskRun(
  db: PgliteDatabase,
  taskRunId: string,
): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as count from assets where task_run_id = ${taskRunId}
  `);
  return Number(result.rows[0]?.count ?? 0);
}

async function loadAssetStorage(db: PgliteDatabase, assetId: string) {
  const result = await db.execute(sql`
    select storage_key as "storageKey", task_run_id as "taskRunId"
    from assets
    where id = ${assetId}
  `);
  const row = result.rows[0];

  return row
    ? {
        storageKey: String(row.storageKey),
        taskRunId: String(row.taskRunId),
      }
    : null;
}

async function getTaskRunSettlement(db: PgliteDatabase, taskRunId: string) {
  const result = await db.execute(sql`
    select
      asset_ids as "assetIds",
      cost_credits as "costCredits",
      failed_at as "failedAt",
      failure_reason as "failureReason",
      finished_at as "finishedAt",
      runtime_status as "runtimeStatus"
    from task_runs
    where id = ${taskRunId}
  `);
  const row = result.rows[0];
  assert.ok(row);

  return {
    assetIds: row.assetIds,
    costCredits: Number(row.costCredits),
    failedAt: row.failedAt === null ? null : "set",
    failureReason: row.failureReason,
    finishedAtIsSet: row.finishedAt !== null,
    runtimeStatus: row.runtimeStatus,
  };
}

async function getWakeUpTaskRunState(
  db: PgliteDatabase,
  taskRunId: string,
): Promise<{
  readonly error: unknown;
  readonly inputSnapshot: unknown;
  readonly reservedCredits: number | null;
  readonly runtimeStatus: unknown;
}> {
  const result = await db.execute(sql`
    select
      error,
      input_snapshot as "inputSnapshot",
      reserved_credits as "reservedCredits",
      runtime_status as "runtimeStatus"
    from task_runs
    where id = ${taskRunId}
  `);
  const row = result.rows[0];
  assert.ok(row);

  return {
    error: row.error,
    inputSnapshot: row.inputSnapshot,
    reservedCredits:
      row.reservedCredits === null ? null : Number(row.reservedCredits),
    runtimeStatus: row.runtimeStatus,
  };
}

async function getTaskDependencyResolvedAtIsSet(
  db: PgliteDatabase,
  childTaskRunId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    select resolved_at as "resolvedAt"
    from task_dependencies
    where child_task_run_id = ${childTaskRunId}
  `);
  const row = result.rows[0];
  assert.ok(row);

  return row.resolvedAt !== null;
}

async function getUserCreditBalance(
  db: PgliteDatabase,
  userId: string,
): Promise<number> {
  const result = await db.execute(sql`
    select credit_balance as "creditBalance" from "user" where id = ${userId}
  `);
  return Number(result.rows[0]?.creditBalance ?? 0);
}

async function getTaskRunCreditState(
  db: PgliteDatabase,
  taskRunId: string,
): Promise<{
  readonly estimatedCreditCost: number | null;
  readonly failureReason: unknown;
  readonly reservedCredits: number | null;
  readonly runtimeStatus: unknown;
}> {
  const result = await db.execute(sql`
    select
      estimated_credit_cost as "estimatedCreditCost",
      failure_reason as "failureReason",
      reserved_credits as "reservedCredits",
      runtime_status as "runtimeStatus"
    from task_runs
    where id = ${taskRunId}
  `);
  const row = result.rows[0];
  assert.ok(row);

  return {
    estimatedCreditCost:
      row.estimatedCreditCost === null ? null : Number(row.estimatedCreditCost),
    failureReason: row.failureReason,
    reservedCredits:
      row.reservedCredits === null ? null : Number(row.reservedCredits),
    runtimeStatus: row.runtimeStatus,
  };
}

async function getCreditLedgerEntries(db: PgliteDatabase): Promise<
  readonly {
    readonly amount: number;
    readonly balanceAfter: number;
    readonly kind: unknown;
    readonly sourceKey: unknown;
    readonly userId: unknown;
  }[]
> {
  const result = await db.execute(sql`
    select
      amount,
      balance_after as "balanceAfter",
      kind,
      source_key as "sourceKey",
      user_id as "userId"
    from credit_ledger_entries
    order by created_at asc, id asc
  `);

  return result.rows.map((row) => ({
    amount: Number(row.amount),
    balanceAfter: Number(row.balanceAfter),
    kind: row.kind,
    sourceKey: row.sourceKey,
    userId: row.userId,
  }));
}

async function insertNodeExecution(
  db: PgliteDatabase,
  input: {
    readonly id: string;
    readonly nodeId?: string;
    readonly ownerUserId?: string;
    readonly workflowId?: string;
  },
): Promise<void> {
  await db.execute(sql`
    insert into node_executions (
      id,
      workflow_id,
      owner_user_id,
      node_id,
      execution_id,
      status,
      output_count,
      target_reason
    ) values (
      ${input.id},
      ${input.workflowId ?? "workflow-id"},
      ${input.ownerUserId ?? "owner-user"},
      ${input.nodeId ?? "node-id"},
      ${input.id},
      'pending',
      1,
      'node_run'
    ) on conflict (id) do nothing
  `);
}

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
