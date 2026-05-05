import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { WorkflowEngine } from "~/lib/workflow/workflow-engine";
import { applyTaskRunStudioProjection } from "~/lib/workflow-runtime/task-run-studio-projection";

describe("Task Run studio projection", () => {
  test("projects pending review Task Runs into existing review UI state", () => {
    const state = addNode("llmGenerator");
    const nodeId = state.document.nodes[0]?.id;
    assert.ok(nodeId);

    const projection = applyTaskRunStudioProjection({
      document: state.document,
      runtime: state.runtime,
      slots: [
        {
          attempt: 2,
          itemIndex: 0,
          nodeExecutionId: "node-execution-1",
          nodeId,
          output: {
            assetId: "asset-text-1",
            kind: "inline-text-asset",
            text: "Draft caption",
          },
          status: "PENDING_REVIEW",
          taskRunId: "task-run-1",
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
        attempt: 2,
        executionId: null,
        outputIndex: 0,
        status: "pending",
        taskRunId: "task-run-1",
        text: "Draft caption",
      },
    ]);
  });

  test("projects approved CDN Task Runs into generator outputs", () => {
    const state = addNode("imageGenerator");
    const nodeId = state.document.nodes[0]?.id;
    assert.ok(nodeId);

    const projection = applyTaskRunStudioProjection({
      document: state.document,
      runtime: state.runtime,
      slots: [
        {
          attempt: 0,
          itemIndex: 1,
          nodeExecutionId: "node-execution-2",
          nodeId,
          output: {
            assetId: "asset-image-1",
            cdnUrl: "https://cdn.example.com/image.png",
            contentType: "image/png",
            kind: "cdn-asset",
          },
          status: "APPROVED",
          taskRunId: "task-run-2",
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
