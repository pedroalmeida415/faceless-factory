import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "reactflow";

import {
  createDefaultWorkflowDocument,
  createWorkflowNode,
  createWorkflowNodeId,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import {
  getGeneratorInputHandles,
  isValidWorkflowConnection,
  normalizeGeneratorTargetHandles,
} from "~/lib/workflow/graph";
import { formatNodeTitle } from "~/lib/workflow/node-definitions";
import {
  buildWorkflowCanvas,
  createWorkflowEditorState,
  createWorkflowRuntimeState,
  syncWorkflowRuntimeState,
  type WorkflowCanvasEdge,
  type WorkflowCanvasNode,
  type WorkflowEditorState,
  type WorkflowRuntimeState,
  type WorkflowStudioSnapshot,
} from "~/lib/workflow/studio-state";
import type { WorkflowNodeKind } from "~/lib/workflow/types";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";

export const DEFAULT_WORKFLOW_ACTIVITY =
  "Connect prompt and media nodes into the generators. Local graph state auto-saves in your browser.";

export type WorkflowEngineState = WorkflowStudioSnapshot;

function sanitizeEditorState(
  document: WorkflowDocument,
  editor: WorkflowEditorState,
): WorkflowEditorState {
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  const edgeIds = new Set(document.edges.map((edge) => edge.id));

  return {
    selectedNodeIds: editor.selectedNodeIds.filter((nodeId) =>
      nodeIds.has(nodeId),
    ),
    selectedEdgeIds: editor.selectedEdgeIds.filter((edgeId) =>
      edgeIds.has(edgeId),
    ),
    nodeDimensionsById: Object.fromEntries(
      Object.entries(editor.nodeDimensionsById).filter(([nodeId]) =>
        nodeIds.has(nodeId),
      ),
    ),
  };
}

function syncEngineState(
  document: WorkflowDocument,
  editor: WorkflowEditorState,
  runtime: WorkflowRuntimeState,
): WorkflowEngineState {
  const normalizedDocument = {
    ...document,
    edges: normalizeGeneratorTargetHandles(document.nodes, document.edges),
  } satisfies WorkflowDocument;

  WorkflowGraphValidator.validateDocument(normalizedDocument);

  return {
    document: normalizedDocument,
    editor: sanitizeEditorState(normalizedDocument, editor),
    runtime: syncWorkflowRuntimeState(normalizedDocument, runtime),
  };
}

function formatDeletionActivity(nodeCount: number, edgeCount: number) {
  const parts: string[] = [];

  if (nodeCount > 0) {
    parts.push(`${nodeCount} node${nodeCount === 1 ? "" : "s"}`);
  }

  if (edgeCount > 0) {
    parts.push(`${edgeCount} connection${edgeCount === 1 ? "" : "s"}`);
  }

  if (!parts.length) {
    return "Nothing selected to delete.";
  }

  return `Deleted ${parts.join(" and ")}.`;
}

function updateDocumentFromCanvasNodes(
  document: WorkflowDocument,
  nextCanvasNodes: WorkflowCanvasNode[],
) {
  const canvasNodeMap = new Map(nextCanvasNodes.map((node) => [node.id, node]));
  const remainingNodeIds = new Set(canvasNodeMap.keys());

  return {
    nodes: document.nodes
      .filter((node) => remainingNodeIds.has(node.id))
      .map((node) => {
        const canvasNode = canvasNodeMap.get(node.id);
        return canvasNode
          ? {
              ...node,
              position: {
                x: canvasNode.position.x,
                y: canvasNode.position.y,
              },
            }
          : node;
      }),
    editor: {
      selectedNodeIds: nextCanvasNodes
        .filter((node) => Boolean(node.selected))
        .map((node) => node.id),
      nodeDimensionsById: Object.fromEntries(
        nextCanvasNodes.flatMap((node) =>
          typeof node.width === "number" && typeof node.height === "number"
            ? [[node.id, { width: node.width, height: node.height }] as const]
            : [],
        ),
      ),
    },
  };
}

function updateDocumentFromCanvasEdges(nextCanvasEdges: WorkflowCanvasEdge[]): {
  edges: WorkflowDocument["edges"];
  selectedEdgeIds: string[];
} {
  return {
    edges: nextCanvasEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? null,
      target: edge.target,
      targetHandle: edge.targetHandle ?? null,
    })),
    selectedEdgeIds: nextCanvasEdges
      .filter((edge) => Boolean(edge.selected))
      .map((edge) => edge.id),
  };
}

export const WorkflowEngine = {
  createInitialState(
    document = createDefaultWorkflowDocument(),
    activity = DEFAULT_WORKFLOW_ACTIVITY,
  ): WorkflowEngineState {
    const editor = createWorkflowEditorState();
    const runtime = createWorkflowRuntimeState(document, activity);
    return syncEngineState(document, editor, runtime);
  },

  hydrate(document: WorkflowDocument, activity = DEFAULT_WORKFLOW_ACTIVITY) {
    return this.createInitialState(document, activity);
  },

  syncState(state: WorkflowEngineState) {
    return syncEngineState(state.document, state.editor, state.runtime);
  },

  canConnect(document: WorkflowDocument, connection: Connection) {
    return isValidWorkflowConnection(document, connection);
  },

  getGeneratorInputs(document: WorkflowDocument, nodeId: string) {
    return getGeneratorInputHandles(document, nodeId);
  },

  addNode(state: WorkflowEngineState, kind: WorkflowNodeKind) {
    const nextState = syncEngineState(
      {
        ...state.document,
        nodes: [
          ...state.document.nodes,
          createWorkflowNode(kind, state.document.nodes.length),
        ],
      },
      state.editor,
      state.runtime,
    );

    nextState.runtime.activity = `${formatNodeTitle(kind)} node added.`;
    return nextState;
  },

  connect(state: WorkflowEngineState, connection: Connection) {
    if (!isValidWorkflowConnection(state.document, connection)) {
      return {
        ...state,
        runtime: {
          ...state.runtime,
          activity: "Invalid connection.",
        },
      } satisfies WorkflowEngineState;
    }

    const { source, target } = connection;
    if (!source || !target) {
      return state;
    }

    return syncEngineState(
      {
        ...state.document,
        edges: [
          ...state.document.edges,
          {
            id: createWorkflowNodeId(),
            source,
            sourceHandle: connection.sourceHandle ?? null,
            target,
            targetHandle: connection.targetHandle ?? null,
          },
        ],
      },
      state.editor,
      state.runtime,
    );
  },

  applyNodeChanges(state: WorkflowEngineState, changes: NodeChange[]) {
    const canvas = buildWorkflowCanvas(state);
    const nextCanvasNodes = applyNodeChanges(
      changes,
      canvas.nodes,
    ) as WorkflowCanvasNode[];
    const nextNodeState = updateDocumentFromCanvasNodes(
      state.document,
      nextCanvasNodes,
    );
    const remainingNodeIds = new Set(
      nextNodeState.nodes.map((node) => node.id),
    );

    return syncEngineState(
      {
        ...state.document,
        nodes: nextNodeState.nodes,
        edges: state.document.edges.filter(
          (edge) =>
            remainingNodeIds.has(edge.source) &&
            remainingNodeIds.has(edge.target),
        ),
      },
      {
        selectedNodeIds: nextNodeState.editor.selectedNodeIds,
        selectedEdgeIds: state.editor.selectedEdgeIds,
        nodeDimensionsById: {
          ...state.editor.nodeDimensionsById,
          ...nextNodeState.editor.nodeDimensionsById,
        },
      },
      state.runtime,
    );
  },

  applyEdgeChanges(state: WorkflowEngineState, changes: EdgeChange[]) {
    const canvas = buildWorkflowCanvas(state);
    const nextCanvasEdges = applyEdgeChanges(
      changes,
      canvas.edges,
    ) as WorkflowCanvasEdge[];
    const nextEdgeState = updateDocumentFromCanvasEdges(nextCanvasEdges);

    return syncEngineState(
      {
        ...state.document,
        edges: nextEdgeState.edges,
      },
      {
        selectedNodeIds: state.editor.selectedNodeIds,
        selectedEdgeIds: nextEdgeState.selectedEdgeIds,
        nodeDimensionsById: state.editor.nodeDimensionsById,
      },
      state.runtime,
    );
  },

  deleteSelection(state: WorkflowEngineState) {
    const selectedNodeIds = new Set(state.editor.selectedNodeIds);
    const selectedEdgeIds = new Set(state.editor.selectedEdgeIds);

    if (!selectedNodeIds.size && !selectedEdgeIds.size) {
      return {
        ...state,
        runtime: {
          ...state.runtime,
          activity: "Nothing selected to delete.",
        },
      } satisfies WorkflowEngineState;
    }

    const edgeIdsToRemove = new Set(
      state.document.edges
        .filter(
          (edge) =>
            selectedEdgeIds.has(edge.id) ||
            selectedNodeIds.has(edge.source) ||
            selectedNodeIds.has(edge.target),
        )
        .map((edge) => edge.id),
    );

    const nextState = syncEngineState(
      {
        ...state.document,
        nodes: state.document.nodes.filter(
          (node) => !selectedNodeIds.has(node.id),
        ),
        edges: state.document.edges.filter(
          (edge) => !edgeIdsToRemove.has(edge.id),
        ),
      },
      createWorkflowEditorState(),
      state.runtime,
    );

    nextState.runtime.activity = formatDeletionActivity(
      selectedNodeIds.size,
      edgeIdsToRemove.size,
    );
    return nextState;
  },

  resetGraph() {
    const nextState = this.createInitialState(
      createDefaultWorkflowDocument(),
      "Workflow reset to the starter graph.",
    );

    return nextState;
  },
};
