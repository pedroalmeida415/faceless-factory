import { test } from "bun:test";
import assert from "node:assert/strict";
import { Effect, ManagedRuntime } from "effect";

import { WorkflowRuntimeCommands } from "~/server/workflow-runtime/workflow-runtime-commands";
import { createWorkflowRuntimeLiveLayer } from "~/server/workflow-runtime/workflow-runtime-composition";

test("live workflow runtime resolves repository SQL services through composition", async () => {
  const runtime = ManagedRuntime.make(createWorkflowRuntimeLiveLayer());
  try {
    const result = await runtime.runPromise(
      Effect.flatMap(WorkflowRuntimeCommands, (commands) =>
        Effect.either(
          commands.handleWakeUpCall({
            ownerUserId: "owner-user",
            settledParentTaskRunId: "missing-parent-for-composition-smoke",
            workflowId: "workflow-id",
          }),
        ),
      ),
    );

    assert.equal(result._tag, "Right");
    if (result._tag === "Right") {
      assert.deepEqual(result.right, {
        reason: "WAKE_UP_PARENT_NOT_FOUND",
        status: "ignored",
      });
    }
  } finally {
    await runtime.dispose();
  }
});
