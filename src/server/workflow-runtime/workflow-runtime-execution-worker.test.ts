import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import { createWorkflowNode } from "~/lib/workflow/document";
import type { ExecutableTaskRunInputSnapshot } from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
import type { TaskStatusEvent } from "~/lib/workflow-runtime/runtime/task-status-events";
import {
  createWorkflowRuntimeExecutionWorker,
  type ProviderExecutionResult,
  type WorkflowRuntimeEventPublisherForWorker,
  type WorkflowRuntimeExecutionWorkerRepository,
  type WorkflowRuntimeProviderExecutor,
  type WorkflowRuntimeSettlementQueueForWorker,
} from "~/server/workflow-runtime/workflow-runtime-execution-worker";
import type {
  WorkflowRuntimeCompletionSettlementJobPayload,
  WorkflowRuntimeExecutionJobPayload,
  WorkflowRuntimeFailureSettlementJobPayload,
} from "~/server/workflow-runtime/workflow-runtime-queue";

describe("WorkflowRuntimeExecutionWorker", () => {
  test("does not execute or settle a Task Run when the queued attempt is not claimed", async () => {
    const repository = new FakeRepository({ claimed: false });
    const providerExecutor = new FakeProviderExecutor({
      ok: true,
      value: providerCompletion(),
    });
    const settlementQueue = new FakeSettlementQueue();
    const eventPublisher = new FakeEventPublisher();
    const worker = createWorkflowRuntimeExecutionWorker({
      eventPublisher,
      providerExecutor,
      repository,
      settlementQueue,
    });

    const result = await worker.execute(executionJob());

    assert.deepEqual(result, { claimed: false });
    assert.deepEqual(repository.claimCommands, [
      { attempt: 0, ownerUserId: "owner-1", taskRunId: "task-run-1" },
    ]);
    assert.deepEqual(providerExecutor.commands, []);
    assert.deepEqual(eventPublisher.published, []);
    assert.deepEqual(settlementQueue.completions, []);
    assert.deepEqual(settlementQueue.failures, []);
  });

  test("publishes Running before executing the claimed input snapshot", async () => {
    const sideEffects: string[] = [];
    const snapshot = inputSnapshot("task-run-1", 0);
    const runningEvent = {
      attempt: 0,
      itemIndex: 0,
      nodeExecutionId: "node-execution-1",
      status: "RUNNING" as const,
      taskRunId: "task-run-1",
    };
    const repository = new FakeRepository({
      claimed: true,
      event: runningEvent,
      inputSnapshot: snapshot,
    });
    const providerExecutor = new FakeProviderExecutor(
      {
        ok: true,
        value: providerCompletion(),
      },
      sideEffects,
    );
    const settlementQueue = new FakeSettlementQueue();
    const eventPublisher = new FakeEventPublisher(sideEffects);
    const worker = createWorkflowRuntimeExecutionWorker({
      eventPublisher,
      providerExecutor,
      repository,
      settlementQueue,
    });

    const result = await worker.execute(executionJob());

    assert.deepEqual(sideEffects, ["publish:task-run-1:RUNNING", "provider"]);
    assert.deepEqual(eventPublisher.published, [
      { events: [runningEvent], workflowId: "workflow-1" },
    ]);
    assert.deepEqual(providerExecutor.commands, [
      {
        inputSnapshot: snapshot,
        ownerUserId: "owner-1",
        workflowId: "workflow-1",
      },
    ]);
    assert.deepEqual(settlementQueue.completions, [
      {
        attempt: 0,
        finalCostCredits: 2,
        generatedAsset: providerCompletion().generatedAsset,
        jobId: "task-run~task-run-1~attempt~0~orchestrator~completion",
        ownerUserId: "owner-1",
        reviewRequired: false,
        taskRunId: "task-run-1",
        workflowId: "workflow-1",
      },
    ]);
    assert.deepEqual(settlementQueue.failures, []);
    assert.deepEqual(result, {
      claimed: true,
      settlement: settlementQueue.completions[0],
    });
  });

  test("enqueues a structured failure settlement when the provider returns failure", async () => {
    const settlementQueue = new FakeSettlementQueue();
    const worker = createWorkflowRuntimeExecutionWorker({
      eventPublisher: new FakeEventPublisher(),
      providerExecutor: new FakeProviderExecutor({
        error: {
          failureReason: {
            message: "provider timeout",
            type: "PROVIDER_FAILED",
          },
          failureSource: {
            taskRunDebitRefundable: true,
            type: "PROVIDER",
          },
          finalCostCredits: 1,
        },
        ok: false,
      }),
      repository: new FakeRepository(claimedResult()),
      settlementQueue,
    });

    await worker.execute(executionJob());

    assert.deepEqual(settlementQueue.failures, [
      {
        attempt: 0,
        failureReason: { message: "provider timeout", type: "PROVIDER_FAILED" },
        failureSource: {
          taskRunDebitRefundable: true,
          type: "PROVIDER",
        },
        finalCostCredits: 1,
        jobId: "task-run~task-run-1~attempt~0~orchestrator~failure",
        ownerUserId: "owner-1",
        taskRunId: "task-run-1",
        workflowId: "workflow-1",
      },
    ]);
    assert.deepEqual(settlementQueue.completions, []);
  });

  test("enqueues a structured failure settlement when the provider throws", async () => {
    const providerExecutor = new FakeProviderExecutor({
      ok: true,
      value: providerCompletion(),
    });
    providerExecutor.thrownError = new Error("sdk exploded");
    const settlementQueue = new FakeSettlementQueue();
    const worker = createWorkflowRuntimeExecutionWorker({
      eventPublisher: new FakeEventPublisher(),
      providerExecutor,
      repository: new FakeRepository(claimedResult()),
      settlementQueue,
    });

    await worker.execute(executionJob());

    assert.deepEqual(settlementQueue.failures, [
      {
        attempt: 0,
        failureReason: { message: "sdk exploded", type: "PROVIDER_FAILED" },
        failureSource: {
          taskRunDebitRefundable: false,
          type: "POST_PROVIDER_INFRASTRUCTURE",
        },
        jobId: "task-run~task-run-1~attempt~0~orchestrator~failure",
        ownerUserId: "owner-1",
        taskRunId: "task-run-1",
        workflowId: "workflow-1",
      },
    ]);
  });

  test("does not call the provider for stale execution jobs", async () => {
    const providerExecutor = new FakeProviderExecutor({
      ok: true,
      value: providerCompletion(),
    });
    const eventPublisher = new FakeEventPublisher();
    const worker = createWorkflowRuntimeExecutionWorker({
      eventPublisher,
      providerExecutor,
      repository: new FakeRepository({ claimed: false }),
      settlementQueue: new FakeSettlementQueue(),
    });

    const result = await worker.execute({
      ...executionJob(),
      attempt: 1,
      jobId: "task-run~task-run-1~attempt~1~execute",
    });

    assert.deepEqual(result, { claimed: false });
    assert.deepEqual(providerExecutor.commands, []);
    assert.deepEqual(eventPublisher.published, []);
  });
});

class FakeRepository implements WorkflowRuntimeExecutionWorkerRepository {
  readonly claimCommands: Parameters<
    WorkflowRuntimeExecutionWorkerRepository["claimQueuedTaskRun"]
  >[0][] = [];

  constructor(
    private readonly claimResult: Awaited<
      ReturnType<WorkflowRuntimeExecutionWorkerRepository["claimQueuedTaskRun"]>
    >,
  ) {}

  claimQueuedTaskRun(
    command: Parameters<
      WorkflowRuntimeExecutionWorkerRepository["claimQueuedTaskRun"]
    >[0],
  ) {
    this.claimCommands.push(command);

    return Promise.resolve(this.claimResult);
  }
}

class FakeProviderExecutor {
  readonly commands: Parameters<
    WorkflowRuntimeProviderExecutor["execute"]
  >[0][] = [];
  thrownError: Error | null = null;

  constructor(
    private readonly result: ProviderExecutionResult,
    private readonly sideEffects?: string[],
  ) {}

  execute(command: Parameters<WorkflowRuntimeProviderExecutor["execute"]>[0]) {
    this.sideEffects?.push("provider");
    this.commands.push(command);
    if (this.thrownError) {
      throw this.thrownError;
    }

    return Promise.resolve(this.result);
  }
}

class FakeEventPublisher implements WorkflowRuntimeEventPublisherForWorker {
  readonly published: {
    readonly events: readonly TaskStatusEvent[];
    readonly workflowId: string;
  }[] = [];

  constructor(private readonly sideEffects?: string[]) {}

  publishTaskStatusEvents(
    workflowId: string,
    events: Parameters<
      WorkflowRuntimeEventPublisherForWorker["publishTaskStatusEvents"]
    >[1],
  ) {
    for (const event of events) {
      this.sideEffects?.push(`publish:${event.taskRunId}:${event.status}`);
    }
    this.published.push({ events, workflowId });

    return Promise.resolve();
  }
}

class FakeSettlementQueue implements WorkflowRuntimeSettlementQueueForWorker {
  readonly completions: WorkflowRuntimeCompletionSettlementJobPayload[] = [];
  readonly failures: WorkflowRuntimeFailureSettlementJobPayload[] = [];

  enqueueCompletionSettlement(
    payload: WorkflowRuntimeCompletionSettlementJobPayload,
  ) {
    this.completions.push(payload);

    return Promise.resolve();
  }

  enqueueFailureSettlement(
    payload: WorkflowRuntimeFailureSettlementJobPayload,
  ) {
    this.failures.push(payload);

    return Promise.resolve();
  }
}

function executionJob(): WorkflowRuntimeExecutionJobPayload {
  return {
    attempt: 0,
    itemIndex: 0,
    jobId: "task-run~task-run-1~attempt~0~execute",
    nodeExecutionId: "node-execution-1",
    ownerUserId: "owner-1",
    taskRunId: "task-run-1",
    workflowId: "workflow-1",
  };
}

function providerCompletion() {
  return {
    finalCostCredits: 2,
    generatedAsset: {
      assetId: "asset-1",
      contentType: "text/plain",
      fileName: "script.txt",
      kind: "text" as const,
      sizeBytes: 11,
      storageProvider: "inline",
      text: "hello world",
    },
    reviewRequired: false,
  };
}

function claimedResult(): Awaited<
  ReturnType<WorkflowRuntimeExecutionWorkerRepository["claimQueuedTaskRun"]>
> {
  return {
    claimed: true,
    event: {
      attempt: 0,
      itemIndex: 0,
      nodeExecutionId: "node-execution-1",
      status: "RUNNING",
      taskRunId: "task-run-1",
    },
    inputSnapshot: inputSnapshot("task-run-1", 0),
  };
}

function inputSnapshot(
  taskRunId: string,
  attempt: number,
): ExecutableTaskRunInputSnapshot {
  const targetNodeConfig = {
    ...createWorkflowNode("llmGenerator", 0),
    id: "node-1",
  };
  return {
    attempt,
    documentRevision: null,
    idempotencyKey: `task_run:${taskRunId}:attempt:${attempt}`,
    itemIndex: 0,
    kind: "task-run-input-snapshot",
    nodeExecutionId: "node-execution-1",
    nodeId: "node-1",
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
