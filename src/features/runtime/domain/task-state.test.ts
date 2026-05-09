import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  buildTaskCoordinateKey,
  buildTaskIdempotencyKey,
  isActiveTaskStatus,
  isDirectTaskFailureReason,
  isFailedTaskStatus,
  isRecoverableByDownstreamPlanningStatus,
  isRenderableTaskStatus,
  isTaskDependencySatisfiedStatus,
  isTerminalTaskStatus,
  isUpstreamTaskFailureReason,
  type TaskCoordinate,
  type TaskFailureReason,
  type TaskFailureReasonType,
  type TaskStatus,
  taskFailureReasonTypeValues,
  taskStatusValues,
} from "~/features/runtime/domain/task-state";

describe("Task state semantics", () => {
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
    ] satisfies TaskStatus[];

    assert.deepEqual(taskStatusValues, expectedStatuses);
    assert.deepEqual(expectedStatuses.filter(isTerminalTaskStatus), [
      "APPROVED",
      "REJECTED",
      "CANCELLED",
      "FAILED",
      "UPSTREAM_FAILED",
    ]);
    assert.deepEqual(expectedStatuses.filter(isActiveTaskStatus), [
      "WAITING_UPSTREAM",
      "QUEUED",
      "RUNNING",
      "PENDING_REVIEW",
    ]);
    assert.deepEqual(expectedStatuses.filter(isFailedTaskStatus), [
      "FAILED",
      "UPSTREAM_FAILED",
    ]);
  });

  test("keeps review rendering separate from dependency satisfaction", () => {
    assert.deepEqual(taskStatusValues.filter(isTaskDependencySatisfiedStatus), [
      "APPROVED",
    ]);
    assert.deepEqual(
      taskStatusValues.filter(isRecoverableByDownstreamPlanningStatus),
      ["CANCELLED", "FAILED", "UPSTREAM_FAILED"],
    );
    assert.equal(isRenderableTaskStatus("PENDING_REVIEW"), true);
    assert.equal(isTaskDependencySatisfiedStatus("PENDING_REVIEW"), false);
  });

  test("builds stable Task coordinate and idempotency identities", () => {
    const coordinate = {
      branchIndex: 7,
      nodeRunId: "node-execution-42",
    } satisfies TaskCoordinate;

    assert.equal(
      buildTaskCoordinateKey(coordinate),
      "node-execution-42:branch:7",
    );
    assert.equal(
      buildTaskIdempotencyKey({
        taskId: "task-run-99",
      }),
      "task:task-run-99",
    );
  });

  test("distinguishes direct failure reasons from inherited Upstream Failed state", () => {
    const expectedFailureReasonTypes = [
      "INSUFFICIENT_CREDITS",
      "PROVIDER_FAILED",
      "EXECUTION_FAILED",
      "UPSTREAM_FAILED",
    ] satisfies TaskFailureReasonType[];
    const directFailureReasons = [
      { type: "INSUFFICIENT_CREDITS" },
      {
        message: "provider returned a terminal error",
        type: "PROVIDER_FAILED",
      },
      { message: "worker timed out", type: "EXECUTION_FAILED" },
    ] satisfies TaskFailureReason[];
    const upstreamFailure = {
      failedParentTaskId: "parent-task-run-1",
      type: "UPSTREAM_FAILED",
    } satisfies TaskFailureReason;
    const insufficientCreditsFailure = {
      type: "INSUFFICIENT_CREDITS",
    } satisfies TaskFailureReason;

    assert.deepEqual(taskFailureReasonTypeValues, expectedFailureReasonTypes);
    assert.deepEqual(directFailureReasons.map(isDirectTaskFailureReason), [
      true,
      true,
      true,
    ]);
    assert.equal(isDirectTaskFailureReason(upstreamFailure), false);
    assert.equal(isUpstreamTaskFailureReason(upstreamFailure), true);
    assert.equal(
      isUpstreamTaskFailureReason(insufficientCreditsFailure),
      false,
    );
  });
});
