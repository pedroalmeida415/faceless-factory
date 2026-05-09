import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { buildTaskInputSnapshot } from "~/features/runtime/execution/task-input-snapshot";
import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDefinitionGraphDocument,
} from "~/features/workflow/document";

describe("TaskInputSnapshot", () => {
  test("builds a dependency-free Task input snapshot with target config and idempotency key", () => {
    const node = {
      ...createWorkflowNode("llmGenerator", 0),
      id: "script-node",
      label: "Script",
    };

    const snapshot = buildTaskInputSnapshot({
      branchIndex: 3,
      nodeRunId: "node-execution-script",
      nodeId: "script-node",
      resolvedParentTasks: [],
      targetNodeConfig: node,
      taskId: "task-run-script",
    });

    assert.equal(snapshot.kind, "task-input-snapshot");
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.taskId, "task-run-script");
    assert.equal(snapshot.nodeRunId, "node-execution-script");
    assert.equal(snapshot.nodeId, "script-node");
    assert.equal(snapshot.branchIndex, 3);
    assert.equal(snapshot.idempotencyKey, "task:task-run-script");
    assert.deepEqual(snapshot.targetNodeConfig, node);
    assert.deepEqual(snapshot.resolvedParentTasks, []);
    assert.deepEqual(snapshot.providerInput, {
      kind: "llm-generation-request",
      request: {
        idempotencyKey: "task:task-run-script",
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

  test("detaches materialized Task snapshots from later non-semantic blueprint edits", () => {
    const node = {
      ...createWorkflowNode("llmGenerator", 0, { x: 10, y: 20 }),
      id: "script-node",
      label: "Script",
    };
    if (node.kind !== "llmGenerator") {
      throw new Error("Expected an LLM generator node.");
    }
    const workflowDefinition: WorkflowDefinitionGraphDocument = {
      edges: [],
      nodes: [node],
      version: WORKFLOW_DOCUMENT_VERSION,
    };

    const snapshot = buildTaskInputSnapshot({
      branchIndex: 0,
      nodeRunId: "node-execution-script",
      nodeId: "script-node",
      resolvedParentTasks: [],
      targetNodeConfig: node,
      taskId: "task-run-script",
      workflowDefinition,
    });

    node.position = { x: 900, y: 1000 };
    workflowDefinition.nodes[0] = {
      ...node,
      position: { x: 400, y: 500 },
    };

    assert.deepEqual(snapshot.targetNodeConfig.position, { x: 10, y: 20 });
    assert.deepEqual(snapshot.workflowDefinition.nodes[0]?.position, {
      x: 10,
      y: 20,
    });
  });
});
