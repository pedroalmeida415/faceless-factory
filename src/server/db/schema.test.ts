import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  taskRunFailureReasonTypeValues,
  taskRunStatusValues,
} from "~/lib/workflow-runtime/domain/task-run-state";
import {
  taskRunFailureReasonEnum,
  taskRunRuntimeStatusEnum,
} from "~/server/db/schema";

describe("workflow runtime schema primitives", () => {
  test("keeps database enums aligned with the runtime domain vocabulary", () => {
    assert.deepEqual(taskRunRuntimeStatusEnum.enumValues, taskRunStatusValues);
    assert.deepEqual(
      taskRunFailureReasonEnum.enumValues,
      taskRunFailureReasonTypeValues,
    );
  });
});
