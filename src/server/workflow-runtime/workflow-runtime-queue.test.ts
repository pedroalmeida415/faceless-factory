import assert from "node:assert/strict";
import { describe, test } from "node:test";

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
        jobId: "task-run:task-run-1:attempt:2:execute",
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
        finalCostCredits: 3,
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
        finalCostCredits: 3,
        generatedAsset: {
          assetId: "asset-1",
          contentType: "text/plain",
          fileName: "asset-1.txt",
          kind: "text",
          sizeBytes: 5,
          storageProvider: "inline",
          text: "hello",
        },
        jobId: "task-run:task-run-1:attempt:2:orchestrator:completion",
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
        ownerUserId: "owner-user-1",
        taskRunId: "task-run-1",
        workflowId: "workflow-1",
      }),
      {
        attempt: 2,
        failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
        jobId: "task-run:task-run-1:attempt:2:orchestrator:failure",
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
        jobId: "wake-up:parent-task-run-1",
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
        options: { jobId: "task-run:task-run-1:attempt:1:execute" },
        payload: job,
      },
    ]);
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
        options: { jobId: "wake-up:parent-task-run-1" },
        payload: job,
      },
    ]);
  });

  test("enqueues completion settlement jobs through BullMQ add with deterministic job id options", async () => {
    const queue = new FakeQueueLike();
    const adapter = createWorkflowRuntimeQueueAdapter(queue);
    const job = buildWorkflowRuntimeCompletionSettlementJobPayload({
      attempt: 1,
      finalCostCredits: 2,
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
          jobId: "task-run:task-run-1:attempt:1:orchestrator:completion",
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
      ownerUserId: "owner-user-1",
      taskRunId: "task-run-1",
      workflowId: "workflow-1",
    });

    await adapter.enqueueFailureSettlement(job);

    assert.deepEqual(queue.added, [
      {
        name: "settle-task-run-failure",
        options: {
          jobId: "task-run:task-run-1:attempt:1:orchestrator:failure",
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

  add(name: string, payload: unknown, options: { readonly jobId: string }) {
    this.added.push({ name, options, payload });

    return Promise.resolve({ id: options.jobId });
  }
}
