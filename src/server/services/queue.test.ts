import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Effect, Logger } from "effect";

import {
  buildRuntimeCompletionSettlementJobPayload,
  buildRuntimeExecutionJobPayload,
  buildRuntimeFailureSettlementJobPayload,
  buildRuntimeWakeUpJobPayload,
  createWorkflowQueueAdapter,
} from "~/server/services/queue";

describe("WorkflowQueueAdapter", () => {
  test("builds deterministic execution job payloads for concrete Tasks", () => {
    assert.deepEqual(
      buildRuntimeExecutionJobPayload({
        branchIndex: 4,
        nodeRunId: "node-execution-1",
        ownerUserId: "owner-user-1",
        taskId: "task-run-1",
        workflowId: "workflow-1",
      }),
      {
        branchIndex: 4,
        jobId: "task~task-run-1~execute",
        nodeRunId: "node-execution-1",
        ownerUserId: "owner-user-1",
        taskId: "task-run-1",
        workflowId: "workflow-1",
      },
    );
  });

  test("builds deterministic completion settlement payloads for concrete Tasks", () => {
    assert.deepEqual(
      buildRuntimeCompletionSettlementJobPayload({
        providerCostCredits: 3,
        generatedAsset: {
          assetId: "asset-1",
          contentType: "text/plain",
          fileName: "asset-1.txt",
          kind: "text",
          sizeBytes: 5,
          storageProvider: "inline",
          text: "hello",
        },
        ownerUserId: "owner-user-1",
        reviewRequired: false,
        taskId: "task-run-1",
        workflowId: "workflow-1",
      }),
      {
        providerCostCredits: 3,
        generatedAsset: {
          assetId: "asset-1",
          contentType: "text/plain",
          fileName: "asset-1.txt",
          kind: "text",
          sizeBytes: 5,
          storageProvider: "inline",
          text: "hello",
        },
        jobId: "task~task-run-1~orchestrator~completion",
        ownerUserId: "owner-user-1",
        reviewRequired: false,
        taskId: "task-run-1",
        workflowId: "workflow-1",
      },
    );
  });

  test("builds deterministic failure settlement payloads for concrete Tasks", () => {
    assert.deepEqual(
      buildRuntimeFailureSettlementJobPayload({
        failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
        failureSource: nonRefundableProviderFailureSource(),
        ownerUserId: "owner-user-1",
        taskId: "task-run-1",
        workflowId: "workflow-1",
      }),
      {
        failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
        failureSource: nonRefundableProviderFailureSource(),
        jobId: "task~task-run-1~orchestrator~failure",
        ownerUserId: "owner-user-1",
        taskId: "task-run-1",
        workflowId: "workflow-1",
      },
    );
  });

  test("builds deterministic Wake-Up Call payloads from settled parent Tasks", () => {
    assert.deepEqual(
      buildRuntimeWakeUpJobPayload({
        ownerUserId: "owner-user-1",
        parentTaskId: "parent-task-run-1",
        workflowId: "workflow-1",
      }),
      {
        jobId: "wake-up~parent-task-run-1",
        ownerUserId: "owner-user-1",
        parentTaskId: "parent-task-run-1",
        workflowId: "workflow-1",
      },
    );
  });

  test("enqueues execution jobs through BullMQ add with deterministic job id options", async () => {
    const queue = new FakeQueueLike();
    const adapter = createWorkflowQueueAdapter(queue);
    const job = buildRuntimeExecutionJobPayload({
      branchIndex: 0,
      nodeRunId: "node-execution-1",
      ownerUserId: "owner-user-1",
      taskId: "task-run-1",
      workflowId: "workflow-1",
    });

    assert.deepEqual(queue.added, []);

    await Effect.runPromise(adapter.enqueueExecutionJob(job));

    assert.deepEqual(queue.added, [
      {
        name: "execute-task-run",
        options: { jobId: "task~task-run-1~execute" },
        payload: job,
      },
    ]);
  });

  test("enqueues one execution job as an Effect with one BullMQ add attempt", async () => {
    const queue = new FakeQueueLike();
    const adapter = createWorkflowQueueAdapter(queue);
    const job = buildRuntimeExecutionJobPayload({
      branchIndex: 0,
      nodeRunId: "node-execution-1",
      ownerUserId: "owner-user-1",
      taskId: "task-run-1",
      workflowId: "workflow-1",
    });

    await Effect.runPromise(adapter.enqueueExecutionJob(job));

    assert.deepEqual(queue.added, [
      {
        name: "execute-task-run",
        options: { jobId: "task~task-run-1~execute" },
        payload: job,
      },
    ]);
  });

  test("rejects custom BullMQ job ids that contain colons before enqueue", async () => {
    const queue = new FakeQueueLike();
    const adapter = createWorkflowQueueAdapter(queue);
    const job = {
      ...buildRuntimeExecutionJobPayload({
        branchIndex: 0,
        nodeRunId: "node-execution-1",
        ownerUserId: "owner-user-1",
        taskId: "task-run-1",
        workflowId: "workflow-1",
      }),
      jobId: "task-run:task-run-1:execute",
    };

    await Effect.runPromiseExit(adapter.enqueueExecutionJob(job)).then(
      (exit) => {
        assert.equal(exit._tag, "Failure");
        assert.match(String(exit.cause), /WorkflowQueueInvalidJobIdError/);
      },
    );
    assert.deepEqual(queue.added, []);
  });

  test("returns typed Effect failures when BullMQ add rejects", async () => {
    const queue = new FakeQueueLike({ failAdds: true });
    const adapter = createWorkflowQueueAdapter(queue);
    const job = buildRuntimeExecutionJobPayload({
      branchIndex: 0,
      nodeRunId: "node-execution-1",
      ownerUserId: "owner-user-1",
      taskId: "task-run-1",
      workflowId: "workflow-1",
    });

    const exit = await Effect.runPromiseExit(
      adapter
        .enqueueExecutionJob(job)
        .pipe(
          Effect.provide(Logger.replace(Logger.defaultLogger, Logger.none)),
        ),
    );

    assert.equal(exit._tag, "Failure");
    assert.match(String(exit.cause), /WorkflowQueuePublishError/);
  });

  test("enqueues Wake-Up Call jobs through BullMQ add with deterministic job id options", async () => {
    const queue = new FakeQueueLike();
    const adapter = createWorkflowQueueAdapter(queue);
    const job = buildRuntimeWakeUpJobPayload({
      ownerUserId: "owner-user-1",
      parentTaskId: "parent-task-run-1",
      workflowId: "workflow-1",
    });

    await Effect.runPromise(adapter.enqueueWakeUpJob(job));

    assert.deepEqual(queue.added, [
      {
        name: "wake-up-task-run-children",
        options: { jobId: "wake-up~parent-task-run-1" },
        payload: job,
      },
    ]);
  });

  test("enqueues one Wake-Up Call job as an Effect with one BullMQ add attempt", async () => {
    const queue = new FakeQueueLike();
    const adapter = createWorkflowQueueAdapter(queue);
    const job = buildRuntimeWakeUpJobPayload({
      ownerUserId: "owner-user-1",
      parentTaskId: "parent-task-run-1",
      workflowId: "workflow-1",
    });

    await Effect.runPromise(adapter.enqueueWakeUpJob(job));

    assert.deepEqual(queue.added, [
      {
        name: "wake-up-task-run-children",
        options: { jobId: "wake-up~parent-task-run-1" },
        payload: job,
      },
    ]);
  });

  test("enqueues completion settlement jobs through BullMQ add with deterministic job id options", async () => {
    const queue = new FakeQueueLike();
    const adapter = createWorkflowQueueAdapter(queue);
    const job = buildRuntimeCompletionSettlementJobPayload({
      providerCostCredits: 2,
      generatedAsset: {
        assetId: "asset-1",
        contentType: "text/plain",
        fileName: "asset-1.txt",
        kind: "text",
        sizeBytes: 5,
        storageProvider: "inline",
        text: "hello",
      },
      ownerUserId: "owner-user-1",
      reviewRequired: false,
      taskId: "task-run-1",
      workflowId: "workflow-1",
    });

    await Effect.runPromise(adapter.enqueueCompletionSettlement(job));

    assert.deepEqual(queue.added, [
      {
        name: "settle-task-run-completion",
        options: {
          jobId: "task~task-run-1~orchestrator~completion",
        },
        payload: job,
      },
    ]);
  });

  test("enqueues failure settlement jobs through BullMQ add with deterministic job id options", async () => {
    const queue = new FakeQueueLike();
    const adapter = createWorkflowQueueAdapter(queue);
    const job = buildRuntimeFailureSettlementJobPayload({
      failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
      failureSource: nonRefundableProviderFailureSource(),
      ownerUserId: "owner-user-1",
      taskId: "task-run-1",
      workflowId: "workflow-1",
    });

    await Effect.runPromise(adapter.enqueueFailureSettlement(job));

    assert.deepEqual(queue.added, [
      {
        name: "settle-task-run-failure",
        options: {
          jobId: "task~task-run-1~orchestrator~failure",
        },
        payload: job,
      },
    ]);
  });
});

type AddedJob = {
  readonly name: string;
  readonly options: { readonly jobId: string };
  readonly payload: unknown;
};

class FakeQueueLike {
  readonly added: AddedJob[] = [];

  constructor(private readonly options: { readonly failAdds?: boolean } = {}) {}

  add(name: string, payload: unknown, options: { readonly jobId: string }) {
    if (this.options.failAdds) {
      return Promise.reject(new Error("forced queue failure"));
    }

    this.added.push({ name, options, payload });

    return Promise.resolve({ id: options.jobId });
  }
}

function nonRefundableProviderFailureSource() {
  return {
    taskDebitRefundable: false,
    type: "PROVIDER" as const,
  };
}
