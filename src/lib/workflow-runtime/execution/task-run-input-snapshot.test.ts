import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
} from "~/lib/workflow/document";
import { buildTaskRunInputSnapshot } from "~/lib/workflow-runtime/execution/task-run-input-snapshot";

describe("TaskRunInputSnapshot", () => {
  test("builds a dependency-free Task Run input snapshot with target config and idempotency key", () => {
    const node = {
      ...createWorkflowNode("llmGenerator", 0),
      id: "script-node",
      label: "Script",
    };

    const snapshot = buildTaskRunInputSnapshot({
      attempt: 2,
      itemIndex: 3,
      nodeExecutionId: "node-execution-script",
      nodeId: "script-node",
      resolvedParentTaskRuns: [],
      targetNodeConfig: node,
      taskRunId: "task-run-script",
    });

    assert.equal(snapshot.kind, "task-run-input-snapshot");
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.taskRunId, "task-run-script");
    assert.equal(snapshot.nodeExecutionId, "node-execution-script");
    assert.equal(snapshot.nodeId, "script-node");
    assert.equal(snapshot.itemIndex, 3);
    assert.equal(snapshot.attempt, 2);
    assert.equal(snapshot.idempotencyKey, "task_run:task-run-script:attempt:2");
    assert.deepEqual(snapshot.targetNodeConfig, node);
    assert.deepEqual(snapshot.resolvedParentTaskRuns, []);
    assert.deepEqual(snapshot.providerInput, {
      kind: "llm-generation-request",
      request: {
        idempotencyKey: "task_run:task-run-script:attempt:2",
        maxOutputTokens: 2048,
        mode: null,
        model: "gemini-3-flash-preview",
        prompt: "",
        referenceImages: [],
        systemPrompt: null,
        temperature: 1,
        thinkingLevel: "LOW",
      },
    });
    assert.equal(WORKFLOW_DOCUMENT_VERSION, 9);
  });
});
