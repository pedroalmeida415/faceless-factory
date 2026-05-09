import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import { toRuntimeTransportOutcome } from "~/features/runtime/server/command-outcome";

describe("runtimeRouter adapter outcome mapping", () => {
  test("keeps committed command outcomes wrapped over transport", () => {
    assert.deepEqual(
      toRuntimeTransportOutcome({
        status: "committed",
        value: { taskId: "task-run-1" },
      }),
      {
        status: "committed",
        value: { taskId: "task-run-1" },
      },
    );
  });

  test("removes Post-Commit Work delivery payloads from committed outcomes", () => {
    const outcome = toRuntimeTransportOutcome({
      status: "committed",
      value: {
        decided: true,
        event: { type: "task-status-changed" },
        executionJob: { jobId: "execution-job-1", taskId: "task-run-2" },
        executionJobs: [{ jobId: "execution-job-2" }],
        nested: {
          taskId: "task-run-1",
          taskStatusEvents: [{ type: "task-status-changed" }],
          wakeUpJob: { jobId: "wake-up-job-1" },
          wakeUpJobs: [{ jobId: "wake-up-job-2" }],
        },
        taskStatusEvents: [{ type: "task-status-changed" }],
      },
    });

    assert.deepEqual(outcome, {
      status: "committed",
      value: {
        decided: true,
        nested: { taskId: "task-run-1" },
      },
    });
    assertNoPostCommitTransportKeys(outcome);
  });

  test("returns a minimal safe committed value when only internals exist", () => {
    const outcome = toRuntimeTransportOutcome({
      status: "committed",
      value: {
        executionJobs: [{ jobId: "execution-job-1" }],
        taskStatusEvents: [{ type: "task-status-changed" }],
        wakeUpJobs: [{ jobId: "wake-up-job-1" }],
      },
    });

    assert.deepEqual(outcome, { status: "committed", value: {} });
    assertNoPostCommitTransportKeys(outcome);
  });

  test("maps ignored command outcomes without backend internals", () => {
    assert.deepEqual(
      toRuntimeTransportOutcome({
        reason: "STALE_TASK_RUN",
        status: "ignored",
      }),
      {
        reason: "STALE_TASK_RUN",
        status: "ignored",
      },
    );
    assert.deepEqual(
      toRuntimeTransportOutcome({
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
