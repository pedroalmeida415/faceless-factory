import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  createEmptyWorkflowDocument,
  createWorkflowNode,
  type WorkflowDocument,
} from "~/features/workflow/document";
import { WorkflowValidationError } from "~/features/workflow/errors";
import { assertActiveTaskSaveAllowed } from "~/features/workflow/save-lock-policy";

function imageGeneratorNode(id: string) {
  const node = createWorkflowNode("imageGenerator", 0, { x: 0, y: 0 });
  if (node.kind !== "imageGenerator") {
    throw new Error("Expected an image generator node.");
  }

  return {
    ...node,
    id,
  };
}

function documentWithActiveGenerator(): WorkflowDocument {
  return {
    ...createEmptyWorkflowDocument(),
    nodes: [imageGeneratorNode("generator-active")],
  };
}

describe("active Task save-lock policy", () => {
  test("allows non-semantic node position edits in the active materialization slice", () => {
    const currentDocument = documentWithActiveGenerator();
    const nextDocument = {
      ...currentDocument,
      nodes: currentDocument.nodes.map((node) => ({
        ...node,
        position: { x: 240, y: 360 },
      })),
    };

    assert.doesNotThrow(() =>
      assertActiveTaskSaveAllowed({
        activeTargetNodeIds: ["generator-active"],
        currentDocument,
        nextDocument,
      }),
    );
  });

  test("allows active node movement when the client document carries runtime output payloads", () => {
    const currentDocument = documentWithActiveGenerator();
    const nextDocument = {
      ...currentDocument,
      nodes: currentDocument.nodes.map((node) => ({
        ...node,
        outputs: [{ id: "client-runtime-output" }],
        position: { x: 240, y: 360 },
        review: {
          items: [{ id: "client-review-item" }],
          valueType: "image",
        },
      })),
    } as WorkflowDocument;

    assert.doesNotThrow(() =>
      assertActiveTaskSaveAllowed({
        activeTargetNodeIds: ["generator-active"],
        currentDocument,
        nextDocument,
      }),
    );
  });

  test("blocks semantic generator edits in the active materialization slice", () => {
    const currentDocument = documentWithActiveGenerator();
    const nextDocument = {
      ...currentDocument,
      nodes: currentDocument.nodes.map((node) => ({
        ...node,
        reviewEnabled: true,
      })),
    };

    assert.throws(
      () =>
        assertActiveTaskSaveAllowed({
          activeTargetNodeIds: ["generator-active"],
          currentDocument,
          nextDocument,
        }),
      WorkflowValidationError,
    );
  });
});
