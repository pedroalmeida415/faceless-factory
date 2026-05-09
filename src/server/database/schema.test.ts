import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  taskFailureReasonTypeValues,
  taskStatusValues,
} from "~/features/runtime/domain/task-state";
import {
  taskFailureReasonEnum,
  taskRuntimeStatusEnum,
} from "~/server/database/schema";

describe("runtime schema primitives", () => {
  test("keeps database enums aligned with the runtime domain vocabulary", () => {
    assert.deepEqual(taskRuntimeStatusEnum.enumValues, taskStatusValues);
    assert.deepEqual(
      taskFailureReasonEnum.enumValues,
      taskFailureReasonTypeValues,
    );
  });
});
