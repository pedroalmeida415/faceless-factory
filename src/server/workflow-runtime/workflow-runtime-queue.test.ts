import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Effect } from "effect";

import {
  buildWorkflowRuntimeCompletionSettlementJobPayload,
  buildWorkflowRuntimeExecutionJobPayload,
  buildWorkflowRuntimeFailureSettlementJobPayload,
  buildWorkflowRuntimeWakeUpJobPayload,
  createWorkflowRuntimeQueueAdapter,
} from "~/server/workflow-runtime/workflow-runtime-queue";

describe("WorkflowRuntimeQueueAdapter", () => {
  test("builds deterministic execution job payloads for concrete Task Run attempts", () => {
    assert.deepEqual(
      buildWorkflowRuntimeExecutionJobPayload({
        attempt: 2,
        itemIndex: 4,
        nodeExecutionId: "node-execution-1",
        ownerUserId: "owner-user-1",
        taskRunId: "task-run-1",
        workflowId: "workflow-1",
      }),
      {
        attempt: 2,
        itemIndex: 4,
        jobId: "task-run~task-run-1~attempt~2~execute",
        nodeExecutionId: "node-execution-1",
        ownerUserId: "owner-user-1",
        taskRunId: "task-run-1",
        workflowId: "workflow-1",
      },
    );
  });

  test("builds deterministic completion settlement payloads for concrete Task Run attempts", () => {
    assert.deepEqual(
      buildWorkflowRuntimeCompletionSettlementJobPayload({
        attempt: 2,
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
        taskRunId: "task-run-1",
        workflowId: "workflow-1",
      }),
      {
        attempt: 2,
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
        jobId: "task-run~task-run-1~attempt~2~orchestrator~completion",
        ownerUserId: "owner-user-1",
        reviewRequired: false,
        taskRunId: "task-run-1",
        workflowId: "workflow-1",
      },
    );
  });

  test("builds deterministic failure settlement payloads for concrete Task Run attempts", () => {
    assert.deepEqual(
      buildWorkflowRuntimeFailureSettlementJobPayload({
        attempt: 2,
        failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
        failureSource: nonRefundableProviderFailureSource(),
        ownerUserId: "owner-user-1",
        taskRunId: "task-run-1",
        workflowId: "workflow-1",
      }),
      {
        attempt: 2,
        failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
        failureSource: nonRefundableProviderFailureSource(),
        jobId: "task-run~task-run-1~attempt~2~orchestrator~failure",
        ownerUserId: "owner-user-1",
        taskRunId: "task-run-1",
        workflowId: "workflow-1",
      },
    );
  });

  test("builds deterministic Wake-Up Call payloads from settled parent Task Runs", () => {
    assert.deepEqual(
      buildWorkflowRuntimeWakeUpJobPayload({
        ownerUserId: "owner-user-1",
        parentTaskRunId: "parent-task-run-1",
        workflowId: "workflow-1",
      }),
      {
        jobId: "wake-up~parent-task-run-1",
        ownerUserId: "owner-user-1",
        parentTaskRunId: "parent-task-run-1",
        workflowId: "workflow-1",
      },
    );
  });

  test("enqueues execution jobs through BullMQ add with deterministic job id options", async () => {
    const queue = new FakeQueueLike();
    const adapter = createWorkflowRuntimeQueueAdapter(queue);
    const job = buildWorkflowRuntimeExecutionJobPayload({
      attempt: 1,
      itemIndex: 0,
      nodeExecutionId: "node-execution-1",
      ownerUserId: "owner-user-1",
      taskRunId: "task-run-1",
      workflowId: "workflow-1",
    });

    assert.deepEqual(queue.added, []);

    await adapter.enqueueExecutionJobs([job]);

    assert.deepEqual(queue.added, [
      {
        name: "execute-task-run",
        options: { jobId: "task-run~task-run-1~attempt~1~execute" },
        payload: job,
      },
    ]);
  });

  test("enqueues one execution job as an Effect with one BullMQ add attempt", async () => {
    const queue = new FakeQueueLike();
    const adapter = createWorkflowRuntimeQueueAdapter(queue);
    const job = buildWorkflowRuntimeExecutionJobPayload({
      attempt: 1,
      itemIndex: 0,
      nodeExecutionId: "node-execution-1",
      ownerUserId: "owner-user-1",
      taskRunId: "task-run-1",
      workflowId: "workflow-1",
    });

    await Effect.runPromise(adapter.enqueueExecutionJob(job));

    assert.deepEqual(queue.added, [
      {
        name: "execute-task-run",
        options: { jobId: "task-run~task-run-1~attempt~1~execute" },
        payload: job,
      },
    ]);
  });

  test("rejects custom BullMQ job ids that contain colons before enqueue", async () => {
    const queue = new FakeQueueLike();
    const adapter = createWorkflowRuntimeQueueAdapter(queue);
    const job = {
      ...buildWorkflowRuntimeExecutionJobPayload({
        attempt: 1,
        itemIndex: 0,
        nodeExecutionId: "node-execution-1",
        ownerUserId: "owner-user-1",
        taskRunId: "task-run-1",
        workflowId: "workflow-1",
      }),
      jobId: "task-run:task-run-1:attempt:1:execute",
    };

    await Effect.runPromiseExit(adapter.enqueueExecutionJob(job)).then(
      (exit) => {
        assert.equal(exit._tag, "Failure");
        assert.match(
          String(exit.cause),
          /WorkflowRuntimeQueueInvalidJobIdError/,
        );
      },
    );
    assert.deepEqual(queue.added, []);
  });

  test("returns typed Effect failures when BullMQ add rejects", async () => {
    const queue = new FakeQueueLike({ failAdds: true });
    const adapter = createWorkflowRuntimeQueueAdapter(queue);
    const job = buildWorkflowRuntimeExecutionJobPayload({
      attempt: 1,
      itemIndex: 0,
      nodeExecutionId: "node-execution-1",
      ownerUserId: "owner-user-1",
      taskRunId: "task-run-1",
      workflowId: "workflow-1",
    });

    const exit = await Effect.runPromiseExit(adapter.enqueueExecutionJob(job));

    assert.equal(exit._tag, "Failure");
    assert.match(String(exit.cause), /WorkflowRuntimeQueuePublishError/);
  });

  test("enqueues Wake-Up Call jobs through BullMQ add with deterministic job id options", async () => {
    const queue = new FakeQueueLike();
    const adapter = createWorkflowRuntimeQueueAdapter(queue);
    const job = buildWorkflowRuntimeWakeUpJobPayload({
      ownerUserId: "owner-user-1",
      parentTaskRunId: "parent-task-run-1",
      workflowId: "workflow-1",
    });

    await adapter.enqueueWakeUpJobs([job]);

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
    const adapter = createWorkflowRuntimeQueueAdapter(queue);
    const job = buildWorkflowRuntimeWakeUpJobPayload({
      ownerUserId: "owner-user-1",
      parentTaskRunId: "parent-task-run-1",
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
    const adapter = createWorkflowRuntimeQueueAdapter(queue);
    const job = buildWorkflowRuntimeCompletionSettlementJobPayload({
      attempt: 1,
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
      taskRunId: "task-run-1",
      workflowId: "workflow-1",
    });

    await adapter.enqueueCompletionSettlement(job);

    assert.deepEqual(queue.added, [
      {
        name: "settle-task-run-completion",
        options: {
          jobId: "task-run~task-run-1~attempt~1~orchestrator~completion",
        },
        payload: job,
      },
    ]);
  });

  test("enqueues failure settlement jobs through BullMQ add with deterministic job id options", async () => {
    const queue = new FakeQueueLike();
    const adapter = createWorkflowRuntimeQueueAdapter(queue);
    const job = buildWorkflowRuntimeFailureSettlementJobPayload({
      attempt: 1,
      failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
      failureSource: nonRefundableProviderFailureSource(),
      ownerUserId: "owner-user-1",
      taskRunId: "task-run-1",
      workflowId: "workflow-1",
    });

    await adapter.enqueueFailureSettlement(job);

    assert.deepEqual(queue.added, [
      {
        name: "settle-task-run-failure",
        options: {
          jobId: "task-run~task-run-1~attempt~1~orchestrator~failure",
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
    taskRunDebitRefundable: false,
    type: "PROVIDER" as const,
  };
}
