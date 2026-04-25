import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "reactflow";

import {
  createEmptyWorkflowDocument,
  createWorkflowNode,
  createWorkflowNodeId,
  specializeWorkflowNodeForValueType,
  type WorkflowDocument,
  type WorkflowPosition,
} from "~/lib/workflow/document";
import {
  findFirstWorkflowHandleIdByValueType,
  getGeneratorInputHandles,
  isValidWorkflowConnection,
  normalizeGeneratorTargetHandles,
  normalizeLaneReorderValueTypes,
  type WorkflowHandleReference,
} from "~/lib/workflow/graph";
import {
  formatNodeTitle,
  LANE_REORDER_OUTPUT_HANDLE_ID,
  type WorkflowValueType,
} from "~/lib/workflow/node-definitions";
import {
  PromptNodeService,
  WorkflowNodeAssetService,
} from "~/lib/workflow/services/node-services";
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
import type { WorkflowAsset, WorkflowNodeKind } from "~/lib/workflow/types";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";

export const DEFAULT_WORKFLOW_ACTIVITY =
  "Connect prompt and media nodes into the generators. Workflow changes auto-save to your project.";

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
  const normalizedEdges = normalizeGeneratorTargetHandles(
    document.nodes,
    document.edges,
  );
  const normalizedNodes = normalizeLaneReorderValueTypes(
    document.nodes,
    normalizedEdges,
  );
  const untypedLaneReorderNodeIds = new Set(
    normalizedNodes.flatMap((node) =>
      node.kind === "laneReorder" && !node.valueType ? [node.id] : [],
    ),
  );
  const normalizedLaneEdges = untypedLaneReorderNodeIds.size
    ? normalizedEdges.filter(
        (edge) =>
          !(
            untypedLaneReorderNodeIds.has(edge.source) &&
            edge.sourceHandle === LANE_REORDER_OUTPUT_HANDLE_ID
          ),
      )
    : normalizedEdges;
  const normalizedDocument =
    normalizedLaneEdges === document.edges && normalizedNodes === document.nodes
      ? document
      : ({
          ...document,
          edges: normalizedLaneEdges,
          nodes: normalizedNodes,
        } satisfies WorkflowDocument);

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

function hasSelectionAndPositionOnlyChanges(changes: NodeChange[]) {
  return changes.every(
    (change) => change.type === "position" || change.type === "select",
  );
}

function hasSelectionOnlyEdgeChanges(changes: EdgeChange[]) {
  return changes.every((change) => change.type === "select");
}

function applySelectionAndPositionChanges(
  state: WorkflowEngineState,
  changes: NodeChange[],
): WorkflowEngineState {
  const positionByNodeId = new Map<string, { x: number; y: number }>();
  const selectionByNodeId = new Map<string, boolean>();

  for (const change of changes) {
    if (!("id" in change)) {
      continue;
    }

    if (change.type === "position") {
      if (!change.position) {
        continue;
      }

      positionByNodeId.set(change.id, change.position);
      continue;
    }

    if (change.type === "select") {
      selectionByNodeId.set(change.id, change.selected);
    }
  }

  const hasPositionUpdates = positionByNodeId.size > 0;
  const hasSelectionUpdates = selectionByNodeId.size > 0;
  let didUpdateDocument = false;

  const nextDocumentNodes = hasPositionUpdates
    ? state.document.nodes.map((node) => {
        const nextPosition = positionByNodeId.get(node.id);
        if (
          !nextPosition ||
          (node.position.x === nextPosition.x &&
            node.position.y === nextPosition.y)
        ) {
          return node;
        }

        didUpdateDocument = true;
        return {
          ...node,
          position: {
            x: nextPosition.x,
            y: nextPosition.y,
          },
        };
      })
    : state.document.nodes;

  const selectedNodeIds = new Set(state.editor.selectedNodeIds);
  if (hasSelectionUpdates) {
    for (const [nodeId, isSelected] of selectionByNodeId) {
      if (isSelected) {
        selectedNodeIds.add(nodeId);
      } else {
        selectedNodeIds.delete(nodeId);
      }
    }
  }

  const nextSelectedNodeIds = hasSelectionUpdates
    ? state.document.nodes
        .filter((node) => selectedNodeIds.has(node.id))
        .map((node) => node.id)
    : state.editor.selectedNodeIds;

  const didUpdateSelection =
    hasSelectionUpdates &&
    (nextSelectedNodeIds.length !== state.editor.selectedNodeIds.length ||
      nextSelectedNodeIds.some(
        (nodeId, index) => state.editor.selectedNodeIds[index] !== nodeId,
      ));

  if (!didUpdateDocument && !didUpdateSelection) {
    return state;
  }

  return {
    document: didUpdateDocument
      ? {
          ...state.document,
          nodes: nextDocumentNodes,
        }
      : state.document,
    editor: didUpdateSelection
      ? {
          ...state.editor,
          selectedNodeIds: nextSelectedNodeIds,
        }
      : state.editor,
    runtime: state.runtime,
  } satisfies WorkflowEngineState;
}

function applyEdgeSelectionChanges(
  state: WorkflowEngineState,
  changes: EdgeChange[],
): WorkflowEngineState {
  const selectedEdgeIds = new Set(state.editor.selectedEdgeIds);

  for (const change of changes) {
    if (change.type !== "select") {
      continue;
    }

    if (change.selected) {
      selectedEdgeIds.add(change.id);
    } else {
      selectedEdgeIds.delete(change.id);
    }
  }

  const nextSelectedEdgeIds = state.document.edges
    .filter((edge) => selectedEdgeIds.has(edge.id))
    .map((edge) => edge.id);

  const didUpdateSelection =
    nextSelectedEdgeIds.length !== state.editor.selectedEdgeIds.length ||
    nextSelectedEdgeIds.some(
      (edgeId, index) => state.editor.selectedEdgeIds[index] !== edgeId,
    );

  if (!didUpdateSelection) {
    return state;
  }

  return {
    document: state.document,
    editor: {
      ...state.editor,
      selectedEdgeIds: nextSelectedEdgeIds,
    },
    runtime: state.runtime,
  } satisfies WorkflowEngineState;
}

export const WorkflowEngine = {
  createInitialState(
    document = createEmptyWorkflowDocument(),
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

  addNode(
    state: WorkflowEngineState,
    kind: WorkflowNodeKind,
    position?: WorkflowPosition,
  ) {
    const nextState = syncEngineState(
      {
        ...state.document,
        nodes: [
          ...state.document.nodes,
          createWorkflowNode(kind, state.document.nodes.length, position),
        ],
      },
      state.editor,
      state.runtime,
    );

    nextState.runtime.activity = `${formatNodeTitle(kind)} node added.`;
    return nextState;
  },

  addConnectedNode(
    state: WorkflowEngineState,
    params: {
      kind: WorkflowNodeKind;
      position: WorkflowPosition;
      startHandle: WorkflowHandleReference;
      valueType: WorkflowValueType;
    },
  ) {
    const specializedNode = specializeWorkflowNodeForValueType(
      createWorkflowNode(
        params.kind,
        state.document.nodes.length,
        params.position,
      ),
      params.valueType,
    );
    const nextNode =
      specializedNode.kind === "prompt" &&
      params.startHandle.handleType === "source" &&
      params.valueType === "text"
        ? PromptNodeService.seedTextVariable(specializedNode).node
        : specializedNode;
    const documentWithNode = {
      ...state.document,
      nodes: [...state.document.nodes, nextNode],
    } satisfies WorkflowDocument;
    const nextHandleId = findFirstWorkflowHandleIdByValueType(
      documentWithNode,
      {
        nodeId: nextNode.id,
        handleType:
          params.startHandle.handleType === "source" ? "target" : "source",
        valueType: params.valueType,
      },
    );

    if (!nextHandleId) {
      const nextState = syncEngineState(
        documentWithNode,
        state.editor,
        state.runtime,
      );
      nextState.runtime.activity = `${formatNodeTitle(params.kind)} node added.`;
      return nextState;
    }

    const connection =
      params.startHandle.handleType === "source"
        ? {
            source: params.startHandle.nodeId,
            sourceHandle: params.startHandle.handleId,
            target: nextNode.id,
            targetHandle: nextHandleId,
          }
        : {
            source: nextNode.id,
            sourceHandle: nextHandleId,
            target: params.startHandle.nodeId,
            targetHandle: params.startHandle.handleId,
          };
    const documentWithEdge = isValidWorkflowConnection(
      documentWithNode,
      connection,
    )
      ? {
          ...documentWithNode,
          edges: [
            ...documentWithNode.edges,
            {
              id: createWorkflowNodeId(),
              source: connection.source,
              sourceHandle: connection.sourceHandle ?? null,
              target: connection.target,
              targetHandle: connection.targetHandle ?? null,
            },
          ],
        }
      : documentWithNode;
    const nextState = syncEngineState(
      documentWithEdge,
      state.editor,
      state.runtime,
    );

    nextState.runtime.activity =
      documentWithEdge === documentWithNode
        ? `${formatNodeTitle(params.kind)} node added.`
        : `${formatNodeTitle(params.kind)} node added and connected.`;

    return nextState;
  },

  addAssetNodeAt(
    state: WorkflowEngineState,
    position: WorkflowPosition,
    assets: WorkflowAsset[],
  ) {
    const nextState = syncEngineState(
      {
        ...state.document,
        nodes: [
          ...state.document.nodes,
          WorkflowNodeAssetService.applyUploadedAssets(
            createWorkflowNode("asset", state.document.nodes.length, position),
            assets,
          ),
        ],
      },
      state.editor,
      state.runtime,
    );

    nextState.runtime.activity = "Asset node added.";
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
    if (hasSelectionAndPositionOnlyChanges(changes)) {
      return applySelectionAndPositionChanges(state, changes);
    }

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
    if (hasSelectionOnlyEdgeChanges(changes)) {
      return applyEdgeSelectionChanges(state, changes);
    }

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
};
