import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  taskRunFailureReasonTypeValues,
  taskRunStatusValues,
} from "~/lib/workflow-runtime/domain/task-run-state";
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
} from "~/lib/workflow-runtime/runtime/task-status-events";

describe("workflow runtime Task Status Event contracts", () => {
  test("uses canonical Task Run statuses and failure reason types", () => {
    assert.equal(taskStatusEventStatusValues, taskRunStatusValues);
    assert.equal(
      taskStatusEventFailureReasonValues,
      taskRunFailureReasonTypeValues,
    );

    for (const status of taskRunStatusValues) {
      const event = buildTaskStatusEvent({
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-status-contract",
        status,
        taskRunId: `task-run-${status.toLowerCase()}`,
      });

      assert.equal(event.status, status);
    }
  });

  test("builds deterministic queue job identities from concrete Task Run attempts", () => {
    assert.equal(
      buildExecutionJobId({ attempt: 2, taskRunId: "task-run-123" }),
      "task-run~task-run-123~attempt~2~execute",
    );
    assert.equal(
      buildWakeUpJobId({ parentTaskRunId: "parent-456" }),
      "wake-up~parent-456",
    );
  });

  test("builds deterministic orchestrator event ids scoped to Task Run attempt", () => {
    assert.equal(
      buildOrchestratorEventId({
        attempt: 3,
        kind: "completion",
        taskRunId: "task-run-789",
      }),
      "task-run~task-run-789~attempt~3~orchestrator~completion",
    );
    assert.equal(
      buildOrchestratorEventId({
        attempt: 3,
        kind: "failure",
        taskRunId: "task-run-789",
      }),
      "task-run~task-run-789~attempt~3~orchestrator~failure",
    );
    assert.equal(
      buildOrchestratorEventId({
        attempt: 3,
        kind: "review",
        taskRunId: "task-run-789",
      }),
      "task-run~task-run-789~attempt~3~orchestrator~review",
    );
  });

  test("creates and validates Task Status Events with CDN asset output", () => {
    const event = buildTaskStatusEvent({
      attempt: 1,
      itemIndex: 0,
      nodeExecutionId: "node-execution-1",
      output: {
        assetId: "asset-1",
        cdnUrl: "https://cdn.example.com/workflow/asset-1.png",
        contentType: "image/png",
        kind: "cdn-asset",
      },
      status: "PENDING_REVIEW",
      taskRunId: "task-run-1",
    });

    assert.deepEqual(TaskStatusEventSchema.parse(event), event);
    assert.equal(event.output?.assetId, "asset-1");
  });

  test("accepts app-relative renderable asset URLs", () => {
    const event = buildTaskStatusEvent({
      attempt: 1,
      itemIndex: 0,
      nodeExecutionId: "node-execution-1",
      output: {
        assetId: "asset-1",
        cdnUrl: "/api/assets/asset-1",
        contentType: "image/png",
        kind: "cdn-asset",
      },
      status: "APPROVED",
      taskRunId: "task-run-1",
    });

    assert.deepEqual(TaskStatusEventSchema.parse(event), event);
  });

  test("creates and validates Task Status Events with inline text output and failure reasons", () => {
    const approved = buildTaskStatusEvent({
      attempt: 2,
      itemIndex: 4,
      nodeExecutionId: "node-execution-2",
      output: {
        assetId: "asset-text-1",
        kind: "inline-text-asset",
        text: "Generated caption",
      },
      status: "APPROVED",
      taskRunId: "task-run-2",
    });
    const failed = buildTaskStatusEvent({
      attempt: 2,
      failureReason: "INSUFFICIENT_CREDITS",
      itemIndex: 4,
      nodeExecutionId: "node-execution-2",
      status: "FAILED",
      taskRunId: "task-run-2",
    });

    assert.deepEqual(TaskStatusEventSchema.parse(approved), approved);
    assert.deepEqual(TaskStatusEventSchema.parse(failed), failed);
  });

  test("guards rendered item indexes from stale lower-attempt events", () => {
    const event = {
      attempt: 2,
      itemIndex: 0,
      nodeExecutionId: "node-execution-1",
      status: "RUNNING",
      taskRunId: "task-run-1",
    } satisfies TaskStatusEvent;

    assert.equal(
      shouldApplyTaskStatusEvent({ currentRenderedAttempt: 1, event }),
      true,
    );
    assert.equal(
      shouldApplyTaskStatusEvent({ currentRenderedAttempt: 2, event }),
      true,
    );
    assert.equal(
      shouldApplyTaskStatusEvent({ currentRenderedAttempt: 3, event }),
      false,
    );
  });
});
