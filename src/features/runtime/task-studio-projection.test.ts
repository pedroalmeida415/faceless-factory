import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { applyTaskStudioProjection } from "~/features/runtime/task-studio-projection";
import { WorkflowEngine } from "~/features/workflow/workflow-engine";

describe("Task studio projection", () => {
  test("projects pending review Tasks into existing review UI state", () => {
    const state = addNode("llmGenerator");
    const nodeId = state.document.nodes[0]?.id;
    assert.ok(nodeId);

    const projection = applyTaskStudioProjection({
      document: state.document,
      runtime: state.runtime,
      slots: [
        {
          branchIndex: 0,
          nodeRunId: "node-execution-1",
          nodeId,
          output: {
            assetId: "asset-text-1",
            kind: "inline-text-asset",
            text: "Draft caption",
          },
          status: "PENDING_REVIEW",
          taskId: "task-run-1",
        },
      ],
    });

    const node = projection.document.nodes[0];
    assert.equal(node?.kind, "llmGenerator");
    assert.equal(projection.activeNodeIds[0], nodeId);
    assert.equal(projection.runtime.nodeStateById[nodeId]?.status, "waiting");
    assert.deepEqual(node.review.outputs, [
      {
        assets: [],
        executionId: null,
        outputIndex: 0,
        status: "pending",
        taskId: "task-run-1",
        text: "Draft caption",
      },
    ]);
  });

  test("projects approved CDN Tasks into generator outputs", () => {
    const state = addNode("imageGenerator");
    const nodeId = state.document.nodes[0]?.id;
    assert.ok(nodeId);

    const projection = applyTaskStudioProjection({
      document: state.document,
      runtime: state.runtime,
      slots: [
        {
          branchIndex: 1,
          nodeRunId: "node-execution-2",
          nodeId,
          output: {
            assetId: "asset-image-1",
            cdnUrl: "https://cdn.example.com/image.png",
            contentType: "image/png",
            kind: "cdn-asset",
          },
          status: "APPROVED",
          taskId: "task-run-2",
        },
      ],
    });

    const node = projection.document.nodes[0];
    assert.equal(node?.kind, "imageGenerator");
    assert.deepEqual(projection.activeNodeIds, []);
    assert.equal(projection.runtime.nodeStateById[nodeId]?.status, "success");
    assert.deepEqual(node.outputs[0], []);
    assert.equal(node.outputs[1]?.[0]?.id, "asset-image-1");
    assert.equal(
      node.outputs[1]?.[0]?.url,
      "https://cdn.example.com/image.png",
    );
  });
});

function addNode(kind: "imageGenerator" | "llmGenerator") {
  return WorkflowEngine.addNode(WorkflowEngine.createInitialState(), kind);
}
