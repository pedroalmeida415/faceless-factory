import type { Edge, Node } from "reactflow";

import type {
  WorkflowDocument,
  WorkflowDocumentEdge,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import type {
  WorkflowNodeData,
  WorkflowNodeStatus,
} from "~/lib/workflow/types";

export type WorkflowCanvasNode = Node<WorkflowNodeData>;
export type WorkflowCanvasEdge = Edge;

export type WorkflowEditorState = {
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  nodeDimensionsById: Record<
    string,
    {
      width: number;
      height: number;
    }
  >;
};

export type WorkflowNodeRuntimeState = {
  status: WorkflowNodeStatus;
  error: string | null;
};

export type WorkflowRuntimeState = {
  activity: string;
  nodeStateById: Record<string, WorkflowNodeRuntimeState>;
};

export type WorkflowStudioSnapshot = {
  document: WorkflowDocument;
  editor: WorkflowEditorState;
  runtime: WorkflowRuntimeState;
};

type WorkflowCanvas = {
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
};

const DEFAULT_EDGE_STYLE = {
  stroke: "rgba(226, 232, 240, 0.55)",
  strokeWidth: 2,
} as const;

export function createWorkflowEditorState(): WorkflowEditorState {
  return {
    selectedNodeIds: [],
    selectedEdgeIds: [],
    nodeDimensionsById: {},
  };
}

export function createWorkflowNodeRuntimeState(): WorkflowNodeRuntimeState {
  return {
    status: "idle",
    error: null,
  };
}

export function createWorkflowRuntimeState(
  document: WorkflowDocument,
  activity: string,
): WorkflowRuntimeState {
  return {
    activity,
    nodeStateById: Object.fromEntries(
      document.nodes.map((node) => [node.id, createWorkflowNodeRuntimeState()]),
    ),
  };
}

export function syncWorkflowRuntimeState(
  document: WorkflowDocument,
  runtime: WorkflowRuntimeState,
): WorkflowRuntimeState {
  return {
    ...runtime,
    nodeStateById: Object.fromEntries(
      document.nodes.map((node) => [
        node.id,
        runtime.nodeStateById[node.id] ?? createWorkflowNodeRuntimeState(),
      ]),
    ),
  };
}

function toWorkflowNodeData(
  node: WorkflowDocumentNode,
  runtimeState: WorkflowNodeRuntimeState | undefined,
): WorkflowNodeData {
  const status = runtimeState?.status ?? "idle";
  const error = runtimeState?.error ?? null;

  switch (node.kind) {
    case "prompt":
      return {
        kind: node.kind,
        label: node.label,
        status,
        error,
        prompt: node.prompt,
      };
    case "asset":
      return {
        kind: node.kind,
        label: node.label,
        status,
        error,
        assetKind: node.assetKind,
        assets: node.assets,
      };
    case "imageGenerator":
      return {
        kind: node.kind,
        label: node.label,
        status,
        error,
        model: node.model,
        mode: node.mode,
        config: node.config,
        lastPrompt: node.lastPrompt,
        responseText: node.responseText,
        outputAssets: node.outputAssets,
      };
    case "videoGenerator":
      return {
        kind: node.kind,
        label: node.label,
        status,
        error,
        model: node.model,
        mode: node.mode,
        config: node.config,
        lastPrompt: node.lastPrompt,
        responseText: node.responseText,
        outputAssets: node.outputAssets,
      };
  }
}

function buildWorkflowCanvasNode(
  node: WorkflowDocumentNode,
  selectedNodeIds: Set<string>,
  runtime: WorkflowRuntimeState,
): WorkflowCanvasNode {
  return {
    id: node.id,
    type: node.kind,
    position: node.position,
    data: toWorkflowNodeData(node, runtime.nodeStateById[node.id]),
    selected: selectedNodeIds.has(node.id),
    style: { width: 320 },
  };
}

function buildWorkflowCanvasEdge(
  edge: WorkflowDocumentEdge,
  selectedEdgeIds: Set<string>,
): WorkflowCanvasEdge {
  return {
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle,
    selected: selectedEdgeIds.has(edge.id),
    type: "smoothstep",
    animated: false,
    style: DEFAULT_EDGE_STYLE,
  };
}

function isSameNodeData(left: WorkflowNodeData, right: WorkflowNodeData) {
  if (
    left.kind !== right.kind ||
    left.label !== right.label ||
    left.status !== right.status ||
    left.error !== right.error
  ) {
    return false;
  }

  if (left.kind === "prompt") {
    return right.kind === "prompt" && left.prompt === right.prompt;
  }

  if (left.kind === "asset") {
    return (
      right.kind === "asset" &&
      left.assetKind === right.assetKind &&
      left.assets === right.assets
    );
  }

  if (left.kind === "imageGenerator") {
    return (
      right.kind === "imageGenerator" &&
      left.model === right.model &&
      left.mode === right.mode &&
      left.config === right.config &&
      left.lastPrompt === right.lastPrompt &&
      left.responseText === right.responseText &&
      left.outputAssets === right.outputAssets
    );
  }

  return (
    right.kind === "videoGenerator" &&
    left.model === right.model &&
    left.mode === right.mode &&
    left.config === right.config &&
    left.lastPrompt === right.lastPrompt &&
    left.responseText === right.responseText &&
    left.outputAssets === right.outputAssets
  );
}

function canReuseNode(
  previousNode: WorkflowCanvasNode,
  nextNode: WorkflowCanvasNode,
) {
  return (
    previousNode.type === nextNode.type &&
    previousNode.selected === nextNode.selected &&
    previousNode.position.x === nextNode.position.x &&
    previousNode.position.y === nextNode.position.y &&
    isSameNodeData(previousNode.data, nextNode.data)
  );
}

function reuseNode(
  previousNode: WorkflowCanvasNode,
  nextNode: WorkflowCanvasNode,
) {
  if (!canReuseNode(previousNode, nextNode)) {
    return nextNode;
  }

  if (
    previousNode.dragging === nextNode.dragging &&
    previousNode.resizing === nextNode.resizing
  ) {
    return previousNode;
  }

  // React Flow mutates transient interaction flags onto nodes while dragging.
  // Preserve measured internals, but clear those flags when syncing from the
  // document snapshot so completed drags do not stay "live" forever.
  return {
    ...previousNode,
    dragging: nextNode.dragging,
    resizing: nextNode.resizing,
  };
}

function canReuseEdge(
  previousEdge: WorkflowCanvasEdge,
  nextEdge: WorkflowCanvasEdge,
) {
  return (
    previousEdge.selected === nextEdge.selected &&
    previousEdge.source === nextEdge.source &&
    previousEdge.sourceHandle === nextEdge.sourceHandle &&
    previousEdge.target === nextEdge.target &&
    previousEdge.targetHandle === nextEdge.targetHandle
  );
}

export function buildWorkflowCanvas(
  snapshot: WorkflowStudioSnapshot,
  previousCanvas?: WorkflowCanvas,
) {
  const selectedNodeIds = new Set(snapshot.editor.selectedNodeIds);
  const selectedEdgeIds = new Set(snapshot.editor.selectedEdgeIds);
  const previousNodeById = previousCanvas
    ? new Map(previousCanvas.nodes.map((node) => [node.id, node]))
    : null;
  const previousEdgeById = previousCanvas
    ? new Map(previousCanvas.edges.map((edge) => [edge.id, edge]))
    : null;

  const nextNodes = snapshot.document.nodes.map((node) => {
    const nextNode = buildWorkflowCanvasNode(
      node,
      selectedNodeIds,
      snapshot.runtime,
    );
    const previousNode = previousNodeById?.get(node.id);

    return previousNode ? reuseNode(previousNode, nextNode) : nextNode;
  });

  const nextEdges = snapshot.document.edges.map((edge) => {
    const nextEdge = buildWorkflowCanvasEdge(edge, selectedEdgeIds);
    const previousEdge = previousEdgeById?.get(edge.id);

    return previousEdge && canReuseEdge(previousEdge, nextEdge)
      ? previousEdge
      : nextEdge;
  });

  const nodes =
    previousCanvas &&
    previousCanvas.nodes.length === nextNodes.length &&
    nextNodes.every((node, index) => node === previousCanvas.nodes[index])
      ? previousCanvas.nodes
      : nextNodes;
  const edges =
    previousCanvas &&
    previousCanvas.edges.length === nextEdges.length &&
    nextEdges.every((edge, index) => edge === previousCanvas.edges[index])
      ? previousCanvas.edges
      : nextEdges;

  return {
    nodes,
    edges,
  };
}
