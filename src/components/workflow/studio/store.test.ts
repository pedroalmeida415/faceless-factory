import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  createEmptyWorkflowDocument,
  createWorkflowNode,
  type WorkflowDocument,
} from "~/features/workflow/document";
import {
  buildWorkflowCanvas,
  createRuntimeState,
  createWorkflowEditorState,
} from "~/features/workflow/studio-state";
import { DEFAULT_WORKFLOW_ACTIVITY } from "~/features/workflow/workflow-engine";

import { useWorkflowStudioStore } from "./store";

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

function resetStoreWithDocument(document: WorkflowDocument) {
  const editor = createWorkflowEditorState();
  const runtime = createRuntimeState(document, DEFAULT_WORKFLOW_ACTIVITY);
  const canvas = buildWorkflowCanvas({ document, editor, runtime });

  useWorkflowStudioStore.setState({
    canRedo: false,
    canUndo: false,
    document,
    documentRevision: 0,
    edges: canvas.edges,
    editor,
    history: { future: [], past: [] },
    isStreamingExecutionStatus: true,
    lastExecutionFinishedAt: null,
    lastKnownCredits: null,
    localDocumentVersion: 0,
    lockedNodeIds: ["generator-active"],
    nodes: canvas.nodes,
    pendingNodeDragHistoryEntry: null,
    projectId: "workflow-project",
    ready: true,
    runtime,
    savedLocalDocumentVersion: 0,
  });
}

describe("workflow studio save-lock policy", () => {
  beforeEach(() => {
    resetStoreWithDocument({
      ...createEmptyWorkflowDocument(),
      nodes: [imageGeneratorNode("generator-active")],
    });
  });

  test("allows node position changes while a Task Run is active", () => {
    useWorkflowStudioStore
      .getState()
      .setNodePosition("generator-active", { x: 125, y: 210 });

    const node = useWorkflowStudioStore
      .getState()
      .document.nodes.find((candidate) => candidate.id === "generator-active");

    assert.equal(node?.position.x, 125);
    assert.equal(node?.position.y, 210);
    assert.equal(useWorkflowStudioStore.getState().localDocumentVersion, 1);
  });

  test("allows React Flow drag-stop position changes while a Task Run is active", () => {
    useWorkflowStudioStore.getState().applyNodeChanges([
      {
        dragging: false,
        id: "generator-active",
        position: { x: 75, y: 95 },
        type: "position",
      },
    ]);

    const node = useWorkflowStudioStore
      .getState()
      .document.nodes.find((candidate) => candidate.id === "generator-active");

    assert.equal(node?.position.x, 75);
    assert.equal(node?.position.y, 95);
    assert.equal(useWorkflowStudioStore.getState().localDocumentVersion, 1);
  });

  test("allows selection-only editor changes while a Task Run is active", () => {
    useWorkflowStudioStore.getState().applyNodeChanges([
      {
        id: "generator-active",
        selected: true,
        type: "select",
      },
    ]);

    assert.deepEqual(useWorkflowStudioStore.getState().editor.selectedNodeIds, [
      "generator-active",
    ]);
    assert.equal(useWorkflowStudioStore.getState().localDocumentVersion, 0);
  });

  test("blocks semantic generator edits while a Task Run is active", () => {
    useWorkflowStudioStore
      .getState()
      .setGeneratorReviewEnabled("generator-active", true);

    const node = useWorkflowStudioStore
      .getState()
      .document.nodes.find((candidate) => candidate.id === "generator-active");

    assert.equal(node?.kind, "imageGenerator");
    assert.equal(node?.reviewEnabled, false);
    assert.equal(useWorkflowStudioStore.getState().localDocumentVersion, 0);
  });
});
