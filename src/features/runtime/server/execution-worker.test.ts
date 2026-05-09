import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import type { TaskStatusEvent } from "~/features/runtime/events/task-status-events";
import type { ExecutableTaskInputSnapshot } from "~/features/runtime/execution/task-input-snapshot";
import {
  type ClaimQueuedTaskForExecutionResult,
  createRuntimeExecutionWorker,
  type EventPublisherServiceForWorker,
  type ProviderExecutionResult,
  type RuntimeExecutionWorkerRepository,
  type RuntimeProviderExecutor,
  type RuntimeSettlementQueueForWorker,
} from "~/features/runtime/server/execution-worker";
import type { RuntimeRepositoryFailure } from "~/features/runtime/server/repository";
import { createWorkflowNode } from "~/features/workflow/document";
import type {
  RuntimeCompletionSettlementJobPayload,
  RuntimeExecutionJobPayload,
  RuntimeFailureSettlementJobPayload,
} from "~/server/services/queue";

describe("RuntimeExecutionWorker", () => {
  test("does not execute or settle a Task when the queued Task is not claimed", async () => {
    const repository = new FakeRepository({ claimed: false });
    const providerExecutor = new FakeProviderExecutor({
      ok: true,
      value: providerCompletion(),
    });
    const settlementQueue = new FakeSettlementQueue();
    const eventPublisher = new FakeEventPublisher();
    const worker = createRuntimeExecutionWorker({
      eventPublisher,
      providerExecutor,
      repository,
      settlementQueue,
    });

    const result = await worker.execute(executionJob());

    assert.deepEqual(result, {
      reason: "STALE_TASK_RUN",
      status: "ignored",
    });
    assert.deepEqual(repository.claimCommands, [
      { ownerUserId: "owner-1", taskId: "task-run-1" },
    ]);
    assert.deepEqual(providerExecutor.commands, []);
    assert.deepEqual(eventPublisher.published, []);
    assert.deepEqual(settlementQueue.completions, []);
    assert.deepEqual(settlementQueue.failures, []);
  });

  test("publishes Running before executing the claimed input snapshot", async () => {
    const sideEffects: string[] = [];
    const snapshot = inputSnapshot("task-run-1");
    const runningEvent = {
      branchIndex: 0,
      nodeRunId: "node-execution-1",
      status: "RUNNING" as const,
      taskId: "task-run-1",
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
    const worker = createRuntimeExecutionWorker({
      eventPublisher,
      providerExecutor,
      repository,
      settlementQueue,
    });

    const result = await worker.execute(executionJob());

    assert.deepEqual(sideEffects, ["publish:task-run-1:RUNNING", "provider"]);
    assert.deepEqual(eventPublisher.published, [
      { event: runningEvent, workflowId: "workflow-1" },
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
        providerCostCredits: 2,
        generatedAsset: providerCompletion().generatedAsset,
        jobId: "task~task-run-1~orchestrator~completion",
        ownerUserId: "owner-1",
        reviewRequired: false,
        taskId: "task-run-1",
        workflowId: "workflow-1",
      },
    ]);
    assert.deepEqual(settlementQueue.failures, []);
    assert.deepEqual(result, {
      status: "committed",
      value: { settlement: settlementQueue.completions[0] },
    });
  });

  test("enqueues a structured failure settlement when the provider returns failure", async () => {
    const settlementQueue = new FakeSettlementQueue();
    const worker = createRuntimeExecutionWorker({
      eventPublisher: new FakeEventPublisher(),
      providerExecutor: new FakeProviderExecutor({
        error: {
          failureReason: {
            message: "provider timeout",
            type: "PROVIDER_FAILED",
          },
          failureSource: {
            taskDebitRefundable: true,
            type: "PROVIDER",
          },
          providerCostCredits: 1,
        },
        ok: false,
      }),
      repository: new FakeRepository(claimedResult()),
      settlementQueue,
    });

    await worker.execute(executionJob());

    assert.deepEqual(settlementQueue.failures, [
      {
        failureReason: { message: "provider timeout", type: "PROVIDER_FAILED" },
        failureSource: {
          taskDebitRefundable: true,
          type: "PROVIDER",
        },
        providerCostCredits: 1,
        jobId: "task~task-run-1~orchestrator~failure",
        ownerUserId: "owner-1",
        taskId: "task-run-1",
        workflowId: "workflow-1",
      },
    ]);
    assert.deepEqual(settlementQueue.completions, []);
  });

  test("enqueues a structured failure settlement when the provider reports infrastructure failure", async () => {
    const providerExecutor = new FakeProviderExecutor({
      error: {
        failureReason: { message: "sdk exploded", type: "PROVIDER_FAILED" },
        failureSource: {
          taskDebitRefundable: false,
          type: "POST_PROVIDER_INFRASTRUCTURE",
        },
      },
      ok: false,
    });
    const settlementQueue = new FakeSettlementQueue();
    const worker = createRuntimeExecutionWorker({
      eventPublisher: new FakeEventPublisher(),
      providerExecutor,
      repository: new FakeRepository(claimedResult()),
      settlementQueue,
    });

    await worker.execute(executionJob());

    assert.deepEqual(settlementQueue.failures, [
      {
        failureReason: { message: "sdk exploded", type: "PROVIDER_FAILED" },
        failureSource: {
          taskDebitRefundable: false,
          type: "POST_PROVIDER_INFRASTRUCTURE",
        },
        jobId: "task~task-run-1~orchestrator~failure",
        ownerUserId: "owner-1",
        taskId: "task-run-1",
        workflowId: "workflow-1",
      },
    ]);
  });

  test("rejects settlement enqueue failures so BullMQ can retry without losing the provider result", async () => {
    const settlementError = new Error("redis unavailable");
    const settlementQueue = new FakeSettlementQueue();
    settlementQueue.completionError = settlementError;
    const worker = createRuntimeExecutionWorker({
      eventPublisher: new FakeEventPublisher(),
      providerExecutor: new FakeProviderExecutor({
        ok: true,
        value: providerCompletion(),
      }),
      repository: new FakeRepository(claimedResult()),
      settlementQueue,
    });

    await assert.rejects(worker.execute(executionJob()), /redis unavailable/);
    assert.equal(settlementQueue.completions.length, 1);
    assert.deepEqual(settlementQueue.failures, []);
  });

  test("returns the canonical ignored outcome for stale execution jobs", async () => {
    const providerExecutor = new FakeProviderExecutor({
      ok: true,
      value: providerCompletion(),
    });
    const eventPublisher = new FakeEventPublisher();
    const worker = createRuntimeExecutionWorker({
      eventPublisher,
      providerExecutor,
      repository: new FakeRepository({ claimed: false }),
      settlementQueue: new FakeSettlementQueue(),
    });

    const result = await worker.execute({
      ...executionJob(),
      jobId: "task~task-run-1~execute",
    });

    assert.deepEqual(result, {
      reason: "STALE_TASK_RUN",
      status: "ignored",
    });
    assert.deepEqual(providerExecutor.commands, []);
    assert.deepEqual(eventPublisher.published, []);
  });

  test("maps stale repository claim failures to the canonical ignored outcome", async () => {
    const providerExecutor = new FakeProviderExecutor({
      ok: true,
      value: providerCompletion(),
    });
    const repository = new FakeRepository(claimedResult());
    repository.claimFailure = {
      _tag: "StaleTaskTransition" as const,
      operation: "claimQueuedTask",
      taskId: "task-run-1",
    };
    const eventPublisher = new FakeEventPublisher();
    const worker = createRuntimeExecutionWorker({
      eventPublisher,
      providerExecutor,
      repository,
      settlementQueue: new FakeSettlementQueue(),
    });

    const result = await worker.execute({
      ...executionJob(),
      jobId: "task~task-run-1~execute",
    });

    assert.deepEqual(result, {
      reason: "STALE_TASK_RUN",
      status: "ignored",
    });
    assert.deepEqual(providerExecutor.commands, []);
    assert.deepEqual(eventPublisher.published, []);
  });
});

class FakeRepository implements RuntimeExecutionWorkerRepository {
  readonly claimCommands: Parameters<
    RuntimeExecutionWorkerRepository["claimQueuedTask"]
  >[0][] = [];
  claimFailure: RuntimeRepositoryFailure | null = null;

  constructor(
    private readonly claimResult: ClaimQueuedTaskForExecutionResult,
  ) {}

  claimQueuedTask(
    command: Parameters<RuntimeExecutionWorkerRepository["claimQueuedTask"]>[0],
  ) {
    this.claimCommands.push(command);
    if (this.claimFailure) {
      return Effect.fail(this.claimFailure);
    }

    return Effect.succeed(this.claimResult);
  }
}

class FakeProviderExecutor {
  readonly commands: Parameters<RuntimeProviderExecutor["execute"]>[0][] = [];
  constructor(
    private readonly result: ProviderExecutionResult,
    private readonly sideEffects?: string[],
  ) {}

  execute(command: Parameters<RuntimeProviderExecutor["execute"]>[0]) {
    this.sideEffects?.push("provider");
    this.commands.push(command);
    return Effect.succeed(this.result);
  }
}

class FakeEventPublisher implements EventPublisherServiceForWorker {
  readonly published: {
    readonly event: TaskStatusEvent;
    readonly workflowId: string;
  }[] = [];

  constructor(private readonly sideEffects?: string[]) {}

  publishTaskStatusEvent(
    workflowId: string,
    event: Parameters<
      EventPublisherServiceForWorker["publishTaskStatusEvent"]
    >[1],
  ) {
    this.sideEffects?.push(`publish:${event.taskId}:${event.status}`);
    this.published.push({ event, workflowId });

    return Effect.void;
  }
}

class FakeSettlementQueue implements RuntimeSettlementQueueForWorker {
  readonly completions: RuntimeCompletionSettlementJobPayload[] = [];
  readonly failures: RuntimeFailureSettlementJobPayload[] = [];
  completionError: Error | null = null;
  failureError: Error | null = null;

  enqueueCompletionSettlement(payload: RuntimeCompletionSettlementJobPayload) {
    if (this.completionError) {
      return Effect.sync(() => {
        this.completions.push(payload);
      }).pipe(Effect.zipRight(Effect.fail(this.completionError)));
    }

    return Effect.sync(() => {
      this.completions.push(payload);
    });
  }

  enqueueFailureSettlement(payload: RuntimeFailureSettlementJobPayload) {
    if (this.failureError) {
      return Effect.sync(() => {
        this.failures.push(payload);
      }).pipe(Effect.zipRight(Effect.fail(this.failureError)));
    }

    return Effect.sync(() => {
      this.failures.push(payload);
    });
  }
}

function executionJob(): RuntimeExecutionJobPayload {
  return {
    branchIndex: 0,
    jobId: "task~task-run-1~execute",
    nodeRunId: "node-execution-1",
    ownerUserId: "owner-1",
    taskId: "task-run-1",
    workflowId: "workflow-1",
  };
}

function providerCompletion() {
  return {
    providerCostCredits: 2,
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

function claimedResult(): ClaimQueuedTaskForExecutionResult {
  return {
    claimed: true,
    event: {
      branchIndex: 0,
      nodeRunId: "node-execution-1",
      status: "RUNNING",
      taskId: "task-run-1",
    },
    inputSnapshot: inputSnapshot("task-run-1"),
  };
}

function inputSnapshot(taskId: string): ExecutableTaskInputSnapshot {
  const targetNodeConfig = {
    ...createWorkflowNode("llmGenerator", 0),
    id: "node-1",
  };
  return {
    documentRevision: null,
    idempotencyKey: `task:${taskId}`,
    branchIndex: 0,
    kind: "task-input-snapshot",
    nodeRunId: "node-execution-1",
    nodeId: "node-1",
    providerInput: {
      kind: "llm-generation-request",
      request: {
        idempotencyKey: `task:${taskId}`,
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
    resolvedParentTasks: [],
    targetNodeConfig,
    taskId,
    version: 1,
    workflowDefinition: {
      edges: [],
      nodes: [targetNodeConfig],
      version: 9,
    },
  };
}
