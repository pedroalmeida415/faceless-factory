import { test } from "bun:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { RuntimeCommands } from "~/features/runtime/server/commands";
import { ServerTestRuntime } from "~/server/effect";

test("server runtime resolves runtime SQL services through composition", async () => {
  const result = await ServerTestRuntime.runPromise(
    Effect.flatMap(RuntimeCommands, (commands) =>
      Effect.either(
        commands.handleWakeUpCall({
          ownerUserId: "owner-user",
          settledParentTaskId: "missing-parent-for-composition-smoke",
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
});
