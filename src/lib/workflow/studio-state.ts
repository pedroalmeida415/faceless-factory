import type { Edge, Node } from "reactflow";

import type {
  WorkflowDocument,
  WorkflowDocumentEdge,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { getPromptVariableValue } from "~/lib/workflow/graph";
import { PROMPT_VARIABLE_HANDLE_COLOR } from "~/lib/workflow/node-definitions";
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
  document: WorkflowDocument,
  node: WorkflowDocumentNode,
  runtimeState: WorkflowNodeRuntimeState | undefined,
): WorkflowNodeData {
  const status = runtimeState?.status ?? "idle";
  const error = runtimeState?.error ?? null;

  switch (node.kind) {
    case "list":
      return {
        kind: node.kind,
        label: node.label,
        status,
        error,
        items: node.items,
      };
    case "prompt":
      return {
        kind: node.kind,
        label: node.label,
        status,
        error,
        displayMode: node.displayMode,
        prompt: node.prompt,
        variables: node.variables.map((variable) => ({
          ...variable,
          value: getPromptVariableValue(document, node.id, variable.key),
        })),
        inputs: node.variables.map((variable, index) => ({
          color: PROMPT_VARIABLE_HANDLE_COLOR,
          id: variable.key,
          label: "Variable",
          labelIndex: index + 1,
        })),
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
    case "laneReorder":
      return {
        kind: node.kind,
        label: node.label,
        status,
        error,
        mode: node.mode,
        order: node.order,
        shift: node.shift,
        valueType: node.valueType,
      };
    case "laneSelect":
      return {
        kind: node.kind,
        label: node.label,
        status,
        error,
        indices: node.indices,
        valueType: node.valueType,
      };
    case "laneSplit":
      return {
        kind: node.kind,
        label: node.label,
        status,
        error,
        splitCount: node.splitCount,
        valueType: node.valueType,
      };
    case "laneMerge":
      return {
        kind: node.kind,
        label: node.label,
        status,
        error,
        valueType: node.valueType,
      };
    case "laneZipAlign":
      return {
        kind: node.kind,
        label: node.label,
        status,
        error,
        mode: node.mode,
        valueType: node.valueType,
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
        outputLanes: node.outputLanes,
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
        outputLanes: node.outputLanes,
      };
    case "llmGenerator":
      return {
        kind: node.kind,
        label: node.label,
        status,
        error,
        model: node.model,
        mode: node.mode,
        config: node.config,
        lastPrompt: node.lastPrompt,
        lastSystemPrompt: node.lastSystemPrompt,
        responseText: node.responseText,
      };
  }
}

function buildWorkflowCanvasNode(
  document: WorkflowDocument,
  node: WorkflowDocumentNode,
  selectedNodeIds: Set<string>,
  runtime: WorkflowRuntimeState,
): WorkflowCanvasNode {
  return {
    id: node.id,
    type: node.kind,
    position: node.position,
    data: toWorkflowNodeData(document, node, runtime.nodeStateById[node.id]),
    selected: selectedNodeIds.has(node.id),
    style: { width: 320 },
  };
}

function isSamePromptInputs(
  left: Extract<WorkflowNodeData, { kind: "prompt" }>["inputs"],
  right: Extract<WorkflowNodeData, { kind: "prompt" }>["inputs"],
) {
  return (
    left.length === right.length &&
    left.every((input, index) => {
      const nextInput = right[index];
      return (
        nextInput &&
        input.id === nextInput.id &&
        input.label === nextInput.label &&
        input.labelIndex === nextInput.labelIndex &&
        input.color === nextInput.color
      );
    })
  );
}

function isSamePromptVariables(
  left: Extract<WorkflowNodeData, { kind: "prompt" }>["variables"],
  right: Extract<WorkflowNodeData, { kind: "prompt" }>["variables"],
) {
  return (
    left.length === right.length &&
    left.every((variable, index) => {
      const nextVariable = right[index];
      return (
        nextVariable &&
        variable.key === nextVariable.key &&
        variable.label === nextVariable.label &&
        variable.value === nextVariable.value
      );
    })
  );
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
    return (
      right.kind === "prompt" &&
      left.prompt === right.prompt &&
      left.displayMode === right.displayMode &&
      isSamePromptVariables(left.variables, right.variables) &&
      isSamePromptInputs(left.inputs, right.inputs)
    );
  }

  if (left.kind === "list") {
    return right.kind === "list" && left.items === right.items;
  }

  if (left.kind === "asset") {
    return (
      right.kind === "asset" &&
      left.assetKind === right.assetKind &&
      left.assets === right.assets
    );
  }

  if (left.kind === "laneReorder") {
    return (
      right.kind === "laneReorder" &&
      left.mode === right.mode &&
      left.order === right.order &&
      left.shift === right.shift &&
      left.valueType === right.valueType
    );
  }

  if (left.kind === "laneSelect") {
    return (
      right.kind === "laneSelect" &&
      left.indices === right.indices &&
      left.valueType === right.valueType
    );
  }

  if (left.kind === "laneSplit") {
    return (
      right.kind === "laneSplit" &&
      left.splitCount === right.splitCount &&
      left.valueType === right.valueType
    );
  }

  if (left.kind === "laneMerge") {
    return right.kind === "laneMerge" && left.valueType === right.valueType;
  }

  if (left.kind === "laneZipAlign") {
    return (
      right.kind === "laneZipAlign" &&
      left.mode === right.mode &&
      left.valueType === right.valueType
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
      left.outputAssets === right.outputAssets &&
      left.outputLanes === right.outputLanes
    );
  }

  if (left.kind === "videoGenerator") {
    return (
      right.kind === "videoGenerator" &&
      left.model === right.model &&
      left.mode === right.mode &&
      left.config === right.config &&
      left.lastPrompt === right.lastPrompt &&
      left.responseText === right.responseText &&
      left.outputAssets === right.outputAssets &&
      left.outputLanes === right.outputLanes
    );
  }

  return (
    right.kind === "llmGenerator" &&
    left.model === right.model &&
    left.mode === right.mode &&
    left.config === right.config &&
    left.lastPrompt === right.lastPrompt &&
    left.lastSystemPrompt === right.lastSystemPrompt &&
    left.responseText === right.responseText
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
      snapshot.document,
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
