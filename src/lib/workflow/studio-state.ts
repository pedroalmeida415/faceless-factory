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
  editor: WorkflowEditorState,
  runtime: WorkflowRuntimeState,
): WorkflowCanvasNode {
  return {
    id: node.id,
    type: node.kind,
    position: node.position,
    data: toWorkflowNodeData(node, runtime.nodeStateById[node.id]),
    selected: editor.selectedNodeIds.includes(node.id),
    style: { width: 320 },
  };
}

function buildWorkflowCanvasEdge(
  edge: WorkflowDocumentEdge,
  editor: WorkflowEditorState,
): WorkflowCanvasEdge {
  return {
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle,
    selected: editor.selectedEdgeIds.includes(edge.id),
    type: "smoothstep",
    animated: false,
    style: DEFAULT_EDGE_STYLE,
  };
}

export function buildWorkflowCanvas(snapshot: WorkflowStudioSnapshot) {
  return {
    nodes: snapshot.document.nodes.map((node) =>
      buildWorkflowCanvasNode(node, snapshot.editor, snapshot.runtime),
    ),
    edges: snapshot.document.edges.map((edge) =>
      buildWorkflowCanvasEdge(edge, snapshot.editor),
    ),
  };
}
