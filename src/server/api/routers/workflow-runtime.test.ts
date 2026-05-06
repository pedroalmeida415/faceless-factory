import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import { toWorkflowRuntimeTransportOutcome } from "~/server/workflow-runtime/workflow-runtime-command-outcome";

describe("workflowRuntimeRouter adapter outcome mapping", () => {
  test("keeps committed command outcomes wrapped over transport", () => {
    assert.deepEqual(
      toWorkflowRuntimeTransportOutcome({
        status: "committed",
        value: { taskRunId: "task-run-1" },
      }),
      {
        status: "committed",
        value: { taskRunId: "task-run-1" },
      },
    );
  });

  test("removes Post-Commit Work delivery payloads from committed outcomes", () => {
    const outcome = toWorkflowRuntimeTransportOutcome({
      status: "committed",
      value: {
        decided: true,
        event: { type: "task-run-status-changed" },
        executionJob: { jobId: "execution-job-1", taskRunId: "task-run-2" },
        executionJobs: [{ jobId: "execution-job-2" }],
        nested: {
          taskRunId: "task-run-1",
          taskStatusEvents: [{ type: "task-run-status-changed" }],
          wakeUpJob: { jobId: "wake-up-job-1" },
          wakeUpJobs: [{ jobId: "wake-up-job-2" }],
        },
        taskStatusEvents: [{ type: "task-run-status-changed" }],
      },
    });

    assert.deepEqual(outcome, {
      status: "committed",
      value: {
        decided: true,
        nested: { taskRunId: "task-run-1" },
      },
    });
    assertNoPostCommitTransportKeys(outcome);
  });

  test("returns a minimal safe committed value when only internals exist", () => {
    const outcome = toWorkflowRuntimeTransportOutcome({
      status: "committed",
      value: {
        executionJobs: [{ jobId: "execution-job-1" }],
        taskStatusEvents: [{ type: "task-run-status-changed" }],
        wakeUpJobs: [{ jobId: "wake-up-job-1" }],
      },
    });

    assert.deepEqual(outcome, { status: "committed", value: {} });
    assertNoPostCommitTransportKeys(outcome);
  });

  test("maps ignored command outcomes without backend internals", () => {
    assert.deepEqual(
      toWorkflowRuntimeTransportOutcome({
        reason: "STALE_TASK_RUN",
        status: "ignored",
      }),
      {
        reason: "STALE_TASK_RUN",
        status: "ignored",
      },
    );
    assert.deepEqual(
      toWorkflowRuntimeTransportOutcome({
        reason: "WAKE_UP_PARENT_NOT_FOUND",
        status: "ignored",
      }),
      {
        reason: "WAKE_UP_PARENT_NOT_FOUND",
        status: "ignored",
      },
    );
  });
});

function assertNoPostCommitTransportKeys(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.ok(serialized);
  for (const key of [
    "event",
    "executionJob",
    "executionJobs",
    "taskStatusEvents",
    "wakeUpJob",
    "wakeUpJobs",
  ]) {
    assert.equal(serialized.includes(key), false, key);
  }
}
