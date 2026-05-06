import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  taskRunFailureReasonTypeValues,
  taskRunStatusValues,
} from "~/features/runtime/domain/task-run-state";
import {
  taskRunFailureReasonEnum,
  taskRunRuntimeStatusEnum,
} from "~/server/database/schema";

describe("runtime schema primitives", () => {
  test("keeps database enums aligned with the runtime domain vocabulary", () => {
    assert.deepEqual(taskRunRuntimeStatusEnum.enumValues, taskRunStatusValues);
    assert.deepEqual(
      taskRunFailureReasonEnum.enumValues,
      taskRunFailureReasonTypeValues,
    );
  });
});
