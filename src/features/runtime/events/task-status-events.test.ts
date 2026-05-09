import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  taskFailureReasonTypeValues,
  taskStatusValues,
} from "~/features/runtime/domain/task-state";
import {
  buildExecutionJobId,
  buildOrchestratorEventId,
  buildTaskStatusEvent,
  buildWakeUpJobId,
  shouldApplyTaskStatusEvent,
  type TaskStatusEvent,
  TaskStatusEventSchema,
  taskStatusEventFailureReasonValues,
  taskStatusEventStatusValues,
} from "~/features/runtime/events/task-status-events";

describe("runtime Task Status Event contracts", () => {
  test("uses canonical Task statuses and failure reason types", () => {
    assert.equal(taskStatusEventStatusValues, taskStatusValues);
    assert.equal(
      taskStatusEventFailureReasonValues,
      taskFailureReasonTypeValues,
    );

    for (const status of taskStatusValues) {
      const event = buildTaskStatusEvent({
        branchIndex: 0,
        nodeRunId: "node-execution-status-contract",
        status,
        taskId: `task-run-${status.toLowerCase()}`,
      });

      assert.equal(event.status, status);
    }
  });

  test("builds deterministic queue job identities from concrete Tasks", () => {
    assert.equal(
      buildExecutionJobId({ taskId: "task-run-123" }),
      "task~task-run-123~execute",
    );
    assert.equal(
      buildWakeUpJobId({ parentTaskId: "parent-456" }),
      "wake-up~parent-456",
    );
  });

  test("builds deterministic orchestrator event ids scoped to Task", () => {
    assert.equal(
      buildOrchestratorEventId({
        kind: "completion",
        taskId: "task-run-789",
      }),
      "task~task-run-789~orchestrator~completion",
    );
    assert.equal(
      buildOrchestratorEventId({
        kind: "failure",
        taskId: "task-run-789",
      }),
      "task~task-run-789~orchestrator~failure",
    );
    assert.equal(
      buildOrchestratorEventId({
        kind: "review",
        taskId: "task-run-789",
      }),
      "task~task-run-789~orchestrator~review",
    );
  });

  test("creates and validates Task Status Events with CDN asset output", () => {
    const event = buildTaskStatusEvent({
      branchIndex: 0,
      nodeRunId: "node-execution-1",
      output: {
        assetId: "asset-1",
        cdnUrl: "https://cdn.example.com/workflow/asset-1.png",
        contentType: "image/png",
        kind: "cdn-asset",
      },
      status: "PENDING_REVIEW",
      taskId: "task-run-1",
    });

    assert.deepEqual(TaskStatusEventSchema.parse(event), event);
    assert.equal(event.output?.assetId, "asset-1");
  });

  test("accepts app-relative renderable asset URLs", () => {
    const event = buildTaskStatusEvent({
      branchIndex: 0,
      nodeRunId: "node-execution-1",
      output: {
        assetId: "asset-1",
        cdnUrl: "/api/assets/asset-1",
        contentType: "image/png",
        kind: "cdn-asset",
      },
      status: "APPROVED",
      taskId: "task-run-1",
    });

    assert.deepEqual(TaskStatusEventSchema.parse(event), event);
  });

  test("creates and validates Task Status Events with inline text output and failure reasons", () => {
    const approved = buildTaskStatusEvent({
      branchIndex: 4,
      nodeRunId: "node-execution-2",
      output: {
        assetId: "asset-text-1",
        kind: "inline-text-asset",
        text: "Generated caption",
      },
      status: "APPROVED",
      taskId: "task-run-2",
    });
    const failed = buildTaskStatusEvent({
      failureReason: "INSUFFICIENT_CREDITS",
      branchIndex: 4,
      nodeRunId: "node-execution-2",
      status: "FAILED",
      taskId: "task-run-2",
    });

    assert.deepEqual(TaskStatusEventSchema.parse(approved), approved);
    assert.deepEqual(TaskStatusEventSchema.parse(failed), failed);
  });

  test("guards rendered branch indexes from stale events", () => {
    const event = {
      branchIndex: 0,
      nodeRunId: "node-execution-1",
      status: "RUNNING",
      taskId: "task-run-1",
    } satisfies TaskStatusEvent;

    assert.equal(
      shouldApplyTaskStatusEvent({
        currentRenderedTaskId: "task-run-0",
        event,
      }),
      true,
    );
    assert.equal(
      shouldApplyTaskStatusEvent({
        currentRenderedTaskId: "task-run-1",
        event,
      }),
      false,
    );
  });
});
