import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  createWorkflowNode,
  deserializeStoredWorkflowGraphDocument,
  toWorkflowDefinitionGraphDocument,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
  type WorkflowDocumentNode,
} from "~/features/workflow/document";
import { WorkflowValidationError } from "~/features/workflow/errors";
import {
  buildExecutionCostProjection,
  estimateRuntimeCreditCostByNodeId,
} from "~/features/workflow/server/pricing-catalog";

describe("Pricing Catalog", () => {
  test("projects supported generation node own-node costs", () => {
    const projection = buildExecutionCostProjection(pricedDocument());

    assert.deepEqual(projection.lineItems, [
      {
        creditCostPerSlot: 10,
        isEstimate: false,
        kind: "imageGenerator",
        nodeId: "image",
      },
      {
        creditCostPerSlot: 40,
        isEstimate: false,
        kind: "videoGenerator",
        nodeId: "video",
      },
      {
        creditCostPerSlot: 1,
        isEstimate: true,
        kind: "llmGenerator",
        nodeId: "script",
      },
    ]);
  });

  test("fails unsupported model pricing instead of defaulting silently", () => {
    const document = pricedDocument();
    const badNode = {
      ...document.nodes.find((node) => node.id === "image"),
      model: "unsupported-image-model",
    } as unknown as WorkflowDocumentNode;

    assert.throws(
      () => buildExecutionCostProjection({ ...document, nodes: [badNode] }),
      WorkflowValidationError,
    );
  });

  test("derives costs from the server catalog and ignores document pricing fields", () => {
    const document = pricedDocument();
    const imageNode = document.nodes.find((node) => node.id === "image");
    assert.ok(imageNode);

    const projected = buildExecutionCostProjection({
      ...document,
      nodes: [
        { ...imageNode, creditCost: 999 } as unknown as WorkflowDocumentNode,
      ],
    });

    assert.equal(projected.costsByNodeId.image?.creditCostPerSlot, 10);
  });

  test("saved workflow definitions do not persist pricing as node configuration", () => {
    const document = pricedDocument();
    const imageNode = document.nodes.find((node) => node.id === "image");
    assert.ok(imageNode);

    const hydrated = deserializeStoredWorkflowGraphDocument({
      ...document,
      nodes: [{ ...imageNode, creditCost: 999 }],
    });
    assert.ok(hydrated);

    const [definitionNode] = toWorkflowDefinitionGraphDocument(hydrated).nodes;
    assert.ok(definitionNode);
    assert.equal("creditCost" in definitionNode, false);
  });

  test("runtime credit-cost map uses own-node per-slot costs only", () => {
    const document = pricedDocument();

    assert.deepEqual(estimateRuntimeCreditCostByNodeId({ document }), {
      image: 10,
      script: 1,
      video: 40,
    });
  });
});

function pricedDocument(): WorkflowDocument {
  const list = createWorkflowNode("list", 0);
  const image = createWorkflowNode("imageGenerator", 1);
  const video = createWorkflowNode("videoGenerator", 2);
  const script = createWorkflowNode("llmGenerator", 3);

  return {
    edges: [
      {
        id: "image-to-video",
        source: "image",
        sourceHandle: "image",
        target: "video",
        targetHandle: "first-frame",
      },
    ],
    nodes: [
      { ...list, id: "topics" },
      { ...image, id: "image" },
      { ...video, id: "video" },
      { ...script, id: "script" },
    ],
    version: WORKFLOW_DOCUMENT_VERSION,
  };
}
