import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildTaskRunCoordinateKey,
  buildTaskRunIdempotencyKey,
  isActiveTaskRunStatus,
  isDirectTaskRunFailureReason,
  isFailedTaskRunStatus,
  isRecoverableByDownstreamPlanningStatus,
  isRenderableTaskRunStatus,
  isTaskRunDependencySatisfiedStatus,
  isTerminalTaskRunStatus,
  isUpstreamTaskRunFailureReason,
  type TaskRunCoordinate,
  type TaskRunFailureReason,
  type TaskRunFailureReasonType,
  type TaskRunStatus,
  taskRunFailureReasonTypeValues,
  taskRunStatusValues,
} from "~/lib/workflow-runtime/domain/task-run-state";

describe("Task Run state semantics", () => {
  test("defines the canonical status set and terminal lifecycle groups", () => {
    const expectedStatuses = [
      "WAITING_UPSTREAM",
      "QUEUED",
      "RUNNING",
      "PENDING_REVIEW",
      "APPROVED",
      "REJECTED",
      "CANCELLED",
      "FAILED",
      "UPSTREAM_FAILED",
    ] satisfies TaskRunStatus[];

    assert.deepEqual(taskRunStatusValues, expectedStatuses);
    assert.deepEqual(expectedStatuses.filter(isTerminalTaskRunStatus), [
      "APPROVED",
      "REJECTED",
      "CANCELLED",
      "FAILED",
      "UPSTREAM_FAILED",
    ]);
    assert.deepEqual(expectedStatuses.filter(isActiveTaskRunStatus), [
      "WAITING_UPSTREAM",
      "QUEUED",
      "RUNNING",
      "PENDING_REVIEW",
    ]);
    assert.deepEqual(expectedStatuses.filter(isFailedTaskRunStatus), [
      "FAILED",
      "UPSTREAM_FAILED",
    ]);
  });

  test("keeps review rendering separate from dependency satisfaction", () => {
    assert.deepEqual(
      taskRunStatusValues.filter(isTaskRunDependencySatisfiedStatus),
      ["APPROVED"],
    );
    assert.deepEqual(
      taskRunStatusValues.filter(isRecoverableByDownstreamPlanningStatus),
      ["CANCELLED", "FAILED", "UPSTREAM_FAILED"],
    );
    assert.equal(isRenderableTaskRunStatus("PENDING_REVIEW"), true);
    assert.equal(isTaskRunDependencySatisfiedStatus("PENDING_REVIEW"), false);
  });

  test("builds stable Task Run coordinate and idempotency identities", () => {
    const coordinate = {
      attempt: 2,
      itemIndex: 7,
      nodeExecutionId: "node-execution-42",
    } satisfies TaskRunCoordinate;

    assert.equal(
      buildTaskRunCoordinateKey(coordinate),
      "node-execution-42:item:7:attempt:2",
    );
    assert.equal(
      buildTaskRunIdempotencyKey({
        attempt: coordinate.attempt,
        taskRunId: "task-run-99",
      }),
      "task_run:task-run-99:attempt:2",
    );
  });

  test("distinguishes direct failure reasons from inherited Upstream Failed state", () => {
    const expectedFailureReasonTypes = [
      "INSUFFICIENT_CREDITS",
      "PROVIDER_FAILED",
      "EXECUTION_FAILED",
      "UPSTREAM_FAILED",
    ] satisfies TaskRunFailureReasonType[];
    const directFailureReasons = [
      { type: "INSUFFICIENT_CREDITS" },
      {
        message: "provider returned a terminal error",
        type: "PROVIDER_FAILED",
      },
      { message: "worker timed out", type: "EXECUTION_FAILED" },
    ] satisfies TaskRunFailureReason[];
    const upstreamFailure = {
      failedParentTaskRunId: "parent-task-run-1",
      type: "UPSTREAM_FAILED",
    } satisfies TaskRunFailureReason;
    const insufficientCreditsFailure = {
      type: "INSUFFICIENT_CREDITS",
    } satisfies TaskRunFailureReason;

    assert.deepEqual(
      taskRunFailureReasonTypeValues,
      expectedFailureReasonTypes,
    );
    assert.deepEqual(directFailureReasons.map(isDirectTaskRunFailureReason), [
      true,
      true,
      true,
    ]);
    assert.equal(isDirectTaskRunFailureReason(upstreamFailure), false);
    assert.equal(isUpstreamTaskRunFailureReason(upstreamFailure), true);
    assert.equal(
      isUpstreamTaskRunFailureReason(insufficientCreditsFailure),
      false,
    );
  });
});
