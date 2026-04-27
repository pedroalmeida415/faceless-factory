"use client";

import { useEffect, useRef } from "react";
import {
  applyNodeChanges as applyReactFlowNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "reactflow";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import {
  hydrateWorkflowGraphDocument,
  toWorkflowGraphDocument,
  updateWorkflowDocumentNode,
  type WorkflowDocument,
  type WorkflowDocumentNode,
  type WorkflowPosition,
} from "~/lib/workflow/document";
import { getErrorMessage } from "~/lib/workflow/errors";
import { collectWorkflowExecutionNodeIds } from "~/lib/workflow/execution/subgraph";
import type {
  WorkflowCreditsSummary,
  WorkflowExecutionRuntimeState,
  WorkflowExecutionStatusResponse,
} from "~/lib/workflow/execution/types";
import {
  isWorkflowRunActiveStatus,
  isWorkflowRunLockingStatus,
} from "~/lib/workflow/execution/types";
import type { WorkflowHandleReference } from "~/lib/workflow/graph";
import type { WorkflowValueType } from "~/lib/workflow/node-definitions";
import type { WorkflowProject } from "~/lib/workflow/project";
import {
  ImageGeneratorService,
  LaneReorderNodeService,
  LaneSelectNodeService,
  LaneSplitNodeService,
  LaneZipAlignNodeService,
  ListNodeService,
  LlmGeneratorService,
  PromptNodeService,
  VideoGeneratorService,
  WorkflowNodeAssetService,
} from "~/lib/workflow/services/node-services";
import { WorkflowPersistenceService } from "~/lib/workflow/services/workflow-persistence-service";
import {
  buildWorkflowCanvas,
  createWorkflowNodeRuntimeState,
  type WorkflowCanvasEdge,
  type WorkflowCanvasNode,
  type WorkflowEditorState,
  type WorkflowNodeRuntimeState,
  type WorkflowRuntimeState,
  type WorkflowStudioSnapshot,
} from "~/lib/workflow/studio-state";
import type {
  GeneratorConfigValue,
  ImageGeneratorModelId,
  PromptDisplayMode,
  PromptVariable,
  VideoGeneratorModelId,
  WorkflowAsset,
  WorkflowNodeKind,
  WorkflowNodeStatus,
} from "~/lib/workflow/types";
import {
  DEFAULT_WORKFLOW_ACTIVITY,
  WorkflowEngine,
} from "~/lib/workflow/workflow-engine";

function snapshotFromState(
  state: Pick<WorkflowStudioState, "document" | "editor" | "runtime">,
) {
  return {
    document: state.document,
    editor: state.editor,
    runtime: state.runtime,
  } satisfies WorkflowStudioSnapshot;
}

function applySnapshotToState(
  state: WorkflowStudioState,
  snapshot: WorkflowStudioSnapshot,
) {
  const previousNodes = state.nodes;
  const previousEdges = state.edges;

  state.document = snapshot.document;
  state.editor = snapshot.editor;
  state.runtime = snapshot.runtime;

  const canvas = buildWorkflowCanvas(snapshot, {
    edges: previousEdges,
    nodes: previousNodes,
  });
  state.nodes = canvas.nodes;
  state.edges = canvas.edges;
}

type WorkflowHistoryEntry = {
  document: WorkflowDocument;
  selectedEdgeIds: string[];
  selectedNodeIds: string[];
};

type WorkflowHistoryState = {
  future: WorkflowHistoryEntry[];
  past: WorkflowHistoryEntry[];
};

const WORKFLOW_HISTORY_LIMIT = 100;
const LOCKED_WORKFLOW_ACTIVITY =
  "Cannot edit nodes that are participating in a running workflow.";

function createHistoryState(): WorkflowHistoryState {
  return {
    future: [],
    past: [],
  };
}

function serializeWorkflowDocument(document: WorkflowDocument) {
  return JSON.stringify(toWorkflowGraphDocument(document));
}

function hasDocumentChanged(
  previousDocument: WorkflowDocument,
  nextDocument: WorkflowDocument,
) {
  return (
    previousDocument !== nextDocument &&
    serializeWorkflowDocument(previousDocument) !==
      serializeWorkflowDocument(nextDocument)
  );
}

function cloneWorkflowDocument(document: WorkflowDocument): WorkflowDocument {
  const cloned = hydrateWorkflowGraphDocument(
    JSON.parse(serializeWorkflowDocument(document)),
  );
  if (!cloned) {
    throw new Error("Workflow document could not be cloned.");
  }
  return cloned;
}

function createHistoryEntry(
  snapshot: WorkflowStudioSnapshot,
): WorkflowHistoryEntry {
  return {
    document: snapshot.document,
    selectedEdgeIds: [...snapshot.editor.selectedEdgeIds],
    selectedNodeIds: [...snapshot.editor.selectedNodeIds],
  };
}

function syncHistoryFlags(state: WorkflowStudioState) {
  state.canUndo = state.history.past.length > 0;
  state.canRedo = state.history.future.length > 0;
}

function resetHistory(state: WorkflowStudioState) {
  state.history = createHistoryState();
  state.pendingNodeDragHistoryEntry = null;
  syncHistoryFlags(state);
}

function syncSelectedNodeIdsFromCanvas(
  state: WorkflowStudioState,
  nodes: WorkflowCanvasNode[],
) {
  const nextSelectedNodeIds = nodes
    .filter((node) => Boolean(node.selected))
    .map((node) => node.id);
  const currentSelectedNodeIds = state.editor.selectedNodeIds;

  if (
    nextSelectedNodeIds.length === currentSelectedNodeIds.length &&
    nextSelectedNodeIds.every(
      (nodeId, index) => currentSelectedNodeIds[index] === nodeId,
    )
  ) {
    return;
  }

  state.editor.selectedNodeIds = nextSelectedNodeIds;
}

function getNodeDimensionsFromCanvas(nodes: WorkflowCanvasNode[]) {
  return Object.fromEntries(
    nodes.flatMap((node) =>
      typeof node.width === "number" && typeof node.height === "number"
        ? [[node.id, { width: node.width, height: node.height }] as const]
        : [],
    ),
  );
}

function syncNodeDimensionsFromCanvas(
  state: WorkflowStudioState,
  nodes: WorkflowCanvasNode[],
) {
  const nextNodeDimensionsById = getNodeDimensionsFromCanvas(nodes);
  const currentNodeDimensionsById = state.editor.nodeDimensionsById;
  const nextNodeIds = Object.keys(nextNodeDimensionsById);
  const currentNodeIds = Object.keys(currentNodeDimensionsById);

  if (
    nextNodeIds.length === currentNodeIds.length &&
    nextNodeIds.every((nodeId) => {
      const currentDimensions = currentNodeDimensionsById[nodeId];
      const nextDimensions = nextNodeDimensionsById[nodeId];

      if (!nextDimensions) {
        return false;
      }

      return (
        currentDimensions?.width === nextDimensions.width &&
        currentDimensions?.height === nextDimensions.height
      );
    })
  ) {
    return;
  }

  state.editor.nodeDimensionsById = nextNodeDimensionsById;
}

function syncDocumentNodePositionsFromCanvas(
  document: WorkflowDocument,
  nodes: WorkflowCanvasNode[],
): WorkflowDocument {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  let didUpdatePosition = false;

  const syncedNodes = document.nodes.map((node) => {
    const canvasNode = nodeById.get(node.id);
    if (
      !canvasNode ||
      (node.position.x === canvasNode.position.x &&
        node.position.y === canvasNode.position.y)
    ) {
      return node;
    }

    didUpdatePosition = true;
    return {
      ...node,
      position: {
        x: canvasNode.position.x,
        y: canvasNode.position.y,
      },
    };
  });

  return didUpdatePosition
    ? {
        ...document,
        nodes: syncedNodes,
      }
    : document;
}

function pushHistoryEntry(
  state: WorkflowStudioState,
  entry: WorkflowHistoryEntry,
) {
  state.history.past.push(entry);
  if (state.history.past.length > WORKFLOW_HISTORY_LIMIT) {
    state.history.past.shift();
  }
  state.history.future = [];
}

function updateRuntimeNodeState(
  runtime: WorkflowRuntimeState,
  nodeId: string,
  updater: (nodeState: WorkflowNodeRuntimeState) => WorkflowNodeRuntimeState,
): WorkflowRuntimeState {
  return {
    ...runtime,
    nodeStateById: {
      ...runtime.nodeStateById,
      [nodeId]: updater(
        runtime.nodeStateById[nodeId] ?? createWorkflowNodeRuntimeState(),
      ),
    },
  };
}

function getLockedExecutionNodeIds(
  document: WorkflowDocument,
  lockedTargetNodeIds: string[],
) {
  return lockedTargetNodeIds.length
    ? collectWorkflowExecutionNodeIds(document, lockedTargetNodeIds)
    : new Set<string>();
}

function commitSnapshot(
  state: WorkflowStudioState,
  nextSnapshot: WorkflowStudioSnapshot,
  options: {
    historyEntry?: WorkflowHistoryEntry;
    persistDocument?: boolean;
    recordHistory?: boolean;
  } = {},
) {
  const previousSnapshot = snapshotFromState(state);
  const shouldRecordHistory = options.recordHistory !== false;
  const documentChanged = hasDocumentChanged(
    previousSnapshot.document,
    nextSnapshot.document,
  );

  if (shouldRecordHistory) {
    const historyDocumentChanged = hasDocumentChanged(
      options.historyEntry?.document ?? previousSnapshot.document,
      nextSnapshot.document,
    );

    if (historyDocumentChanged) {
      pushHistoryEntry(
        state,
        options.historyEntry ?? createHistoryEntry(previousSnapshot),
      );
    }
  }

  applySnapshotToState(state, nextSnapshot);
  if (documentChanged && options.persistDocument !== false) {
    state.localDocumentVersion += 1;
  }
  syncHistoryFlags(state);
}

function runSnapshotMutation(
  state: WorkflowStudioState,
  buildNextSnapshot: () => WorkflowStudioSnapshot,
  options?: {
    historyEntry?: WorkflowHistoryEntry;
    persistDocument?: boolean;
    recordHistory?: boolean;
  },
) {
  try {
    commitSnapshot(state, buildNextSnapshot(), options);
  } catch (error) {
    state.runtime.activity = getErrorMessage(error);
  }
}

function restoreHistoryEntry(
  state: WorkflowStudioState,
  entry: WorkflowHistoryEntry,
) {
  const nextSnapshot = WorkflowEngine.syncState({
    document: cloneWorkflowDocument(entry.document),
    editor: {
      selectedEdgeIds: [...entry.selectedEdgeIds],
      selectedNodeIds: [...entry.selectedNodeIds],
      nodeDimensionsById: state.editor.nodeDimensionsById,
    },
    runtime: state.runtime,
  });
  const documentChanged = hasDocumentChanged(
    state.document,
    nextSnapshot.document,
  );

  applySnapshotToState(state, nextSnapshot);
  if (documentChanged) {
    state.localDocumentVersion += 1;
  }
}

function mergeExecutionTargetResults(
  currentDocument: WorkflowDocument,
  executionState: WorkflowExecutionStatusResponse,
) {
  const projectedNodeById = new Map(
    executionState.document.nodes.map((node) => [node.id, node]),
  );

  return {
    ...currentDocument,
    nodes: currentDocument.nodes.map((node) => {
      const projectedNode = projectedNodeById.get(node.id);
      if (
        node.kind === "imageGenerator" &&
        projectedNode?.kind === "imageGenerator"
      ) {
        return {
          ...node,
          lastPrompt: projectedNode.lastPrompt,
          outputLanes: mergeMediaExecutionLanes({
            currentLanes: node.outputLanes,
            projectedLanes: projectedNode.outputLanes,
          }),
          review: mergeExecutionReview(node.review, projectedNode.review),
        };
      }

      if (
        node.kind === "videoGenerator" &&
        projectedNode?.kind === "videoGenerator"
      ) {
        return {
          ...node,
          lastPrompt: projectedNode.lastPrompt,
          outputLanes: mergeMediaExecutionLanes({
            currentLanes: node.outputLanes,
            projectedLanes: projectedNode.outputLanes,
          }),
          review: mergeExecutionReview(node.review, projectedNode.review),
        };
      }

      if (
        node.kind === "llmGenerator" &&
        projectedNode?.kind === "llmGenerator"
      ) {
        return {
          ...node,
          lastPrompt: projectedNode.lastPrompt,
          lastSystemPrompt: projectedNode.lastSystemPrompt,
          outputLanes: mergeTextExecutionLanes({
            currentLanes: node.outputLanes,
            projectedLanes: projectedNode.outputLanes,
          }),
          review: mergeExecutionReview(node.review, projectedNode.review),
        };
      }

      return node;
    }),
  } satisfies WorkflowDocument;
}

function mergeMediaExecutionLanes(params: {
  currentLanes: readonly WorkflowAsset[][];
  projectedLanes: readonly WorkflowAsset[][];
}) {
  const laneCount = Math.max(
    params.currentLanes.length,
    params.projectedLanes.length,
  );
  const lanes = Array.from(
    { length: laneCount },
    (_, laneIndex) => params.currentLanes[laneIndex] ?? [],
  );
  for (
    let laneIndex = 0;
    laneIndex < params.projectedLanes.length;
    laneIndex += 1
  ) {
    const projectedLane = params.projectedLanes[laneIndex];
    if (projectedLane?.length) {
      lanes[laneIndex] = projectedLane;
    }
  }
  return lanes;
}

function mergeTextExecutionLanes(params: {
  currentLanes: readonly string[];
  projectedLanes: readonly string[];
}) {
  const laneCount = Math.max(
    params.currentLanes.length,
    params.projectedLanes.length,
  );
  const lanes = Array.from(
    { length: laneCount },
    (_, laneIndex) => params.currentLanes[laneIndex] ?? "",
  );
  for (
    let laneIndex = 0;
    laneIndex < params.projectedLanes.length;
    laneIndex += 1
  ) {
    const projectedLane = params.projectedLanes[laneIndex];
    if (projectedLane?.trim()) {
      lanes[laneIndex] = projectedLane;
    }
  }
  return lanes;
}

type ReviewState = WorkflowDocument["nodes"][number] extends infer Node
  ? Node extends { review: infer Review }
    ? Review
    : never
  : never;

function mergeExecutionReview(
  currentReview: ReviewState,
  projectedReview: ReviewState,
) {
  if (!projectedReview.lanes.length) {
    return currentReview;
  }

  const currentLaneByIndex = new Map(
    currentReview.lanes.map((lane) => [lane.laneIndex, lane]),
  );
  const projectedLaneByIndex = new Map(
    projectedReview.lanes.map((lane) => [lane.laneIndex, lane]),
  );
  const laneIndexes = new Set([
    ...currentLaneByIndex.keys(),
    ...projectedLaneByIndex.keys(),
  ]);

  return {
    ...currentReview,
    sourceNodeId: projectedReview.sourceNodeId,
    updatedAt: projectedReview.updatedAt ?? currentReview.updatedAt,
    valueType: projectedReview.valueType,
    lanes: Array.from(laneIndexes)
      .sort((left, right) => left - right)
      .flatMap((laneIndex) => {
        const currentLane = currentLaneByIndex.get(laneIndex);
        const projectedLane = projectedLaneByIndex.get(laneIndex);
        if (!projectedLane) {
          return currentLane ? [currentLane] : [];
        }
        if (!currentLane) {
          return [projectedLane];
        }
        return [
          {
            ...projectedLane,
            assets: projectedLane.assets.length
              ? projectedLane.assets
              : currentLane.assets,
            text:
              projectedLane.text && projectedLane.text.trim().length > 0
                ? projectedLane.text
                : currentLane.text,
          },
        ];
      }),
  };
}

function mergeExecutionRuntimeState(
  currentRuntime: WorkflowRuntimeState,
  executionState: WorkflowExecutionStatusResponse,
): WorkflowRuntimeState {
  return {
    activity: executionState.runtime.activity,
    nodeStateById: {
      ...currentRuntime.nodeStateById,
      ...executionState.runtime.nodeStateById,
    },
  };
}

const initialSnapshot = WorkflowEngine.createInitialState();
const initialCanvas = buildWorkflowCanvas(initialSnapshot);

type WorkflowStudioState = {
  document: WorkflowDocument;
  documentRevision: number | null;
  editor: WorkflowEditorState;
  localDocumentVersion: number;
  projectId: string | null;
  runtime: WorkflowRuntimeState;
  activeRunId: string | null;
  isStreamingExecutionStatus: boolean;
  lockedNodeIds: string[];
  lastExecutionFinishedAt: string | null;
  lastKnownCredits: WorkflowCreditsSummary | null;
  lastServerRuntime: WorkflowExecutionRuntimeState | null;
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
  history: WorkflowHistoryState;
  pendingNodeDragHistoryEntry: WorkflowHistoryEntry | null;
  canUndo: boolean;
  canRedo: boolean;
  ready: boolean;
  hydrate: (project: WorkflowProject) => void;
  applyServerExecutionState: (
    executionState: WorkflowExecutionStatusResponse,
  ) => void;
  clearActiveRunId: () => void;
  setProjectPersistence: (documentRevision: number) => void;
  setActivity: (activity: string) => void;
  setActiveRunId: (runId: string) => void;
  setExecutionStreaming: (isStreaming: boolean) => void;
  setNodeRuntimeState: (
    nodeId: string,
    status: WorkflowNodeStatus,
    error: string | null,
  ) => void;
  updateDocumentNode: (
    nodeId: string,
    updater: (node: WorkflowDocumentNode) => WorkflowDocumentNode,
  ) => void;
  setListItems: (nodeId: string, items: string[]) => void;
  setLaneReorderMode: (nodeId: string, mode: "shift" | "manual") => void;
  setLaneReorderOrder: (nodeId: string, order: number[]) => void;
  setLaneReorderShift: (nodeId: string, shift: number) => void;
  setLaneReorderValueType: (
    nodeId: string,
    valueType: WorkflowValueType | null,
  ) => void;
  setLaneSelectIndices: (nodeId: string, indices: number[]) => void;
  setLaneSplitCount: (nodeId: string, splitCount: number) => void;
  setLaneZipAlignMode: (nodeId: string, mode: "zip" | "broadcast") => void;
  setPrompt: (nodeId: string, prompt: string) => void;
  setPromptDisplayMode: (
    nodeId: string,
    displayMode: PromptDisplayMode,
  ) => void;
  addPromptVariable: (nodeId: string) => PromptVariable | null;
  setImageGeneratorModel: (
    nodeId: string,
    model: ImageGeneratorModelId,
  ) => void;
  setVideoGeneratorModel: (
    nodeId: string,
    model: VideoGeneratorModelId,
  ) => void;
  setImageGeneratorMode: (nodeId: string, mode: string) => void;
  setVideoGeneratorMode: (nodeId: string, mode: string) => void;
  setImageGeneratorConfigValue: (
    nodeId: string,
    key: string,
    value: GeneratorConfigValue,
  ) => void;
  setLlmGeneratorConfigValue: (
    nodeId: string,
    key: string,
    value: GeneratorConfigValue,
  ) => void;
  setVideoGeneratorConfigValue: (
    nodeId: string,
    key: string,
    value: GeneratorConfigValue,
  ) => void;
  setGeneratorReviewEnabled: (nodeId: string, enabled: boolean) => void;
  setNodePosition: (
    nodeId: string,
    position: WorkflowPosition,
    options?: {
      recordHistory?: boolean;
    },
  ) => void;
  clearNodeAssets: (nodeId: string) => void;
  applyNodeChanges: (changes: NodeChange[]) => void;
  applyEdgeChanges: (changes: EdgeChange[]) => void;
  connect: (connection: Connection) => void;
  canConnect: (connection: Connection) => boolean;
  addNode: (
    kind: WorkflowNodeKind,
    position?: WorkflowPosition,
  ) => string | null;
  addConnectedNode: (params: {
    kind: WorkflowNodeKind;
    position: WorkflowPosition;
    startHandle: WorkflowHandleReference;
    valueType: WorkflowValueType;
  }) => void;
  addAssetNodeAt: (
    position: WorkflowPosition,
    assets: WorkflowAsset[],
  ) => string | null;
  clearSelection: () => void;
  deleteSelection: () => void;
  undo: () => void;
  redo: () => void;
};

export const useWorkflowStudioStore = create<WorkflowStudioState>()(
  immer((set, get) => ({
    document: initialSnapshot.document,
    documentRevision: null,
    editor: initialSnapshot.editor,
    localDocumentVersion: 0,
    projectId: null,
    runtime: initialSnapshot.runtime,
    activeRunId: null,
    isStreamingExecutionStatus: false,
    lockedNodeIds: [],
    lastExecutionFinishedAt: null,
    lastKnownCredits: null,
    lastServerRuntime: null,
    nodes: initialCanvas.nodes,
    edges: initialCanvas.edges,
    history: createHistoryState(),
    pendingNodeDragHistoryEntry: null,
    canUndo: false,
    canRedo: false,
    ready: false,

    hydrate: (project) => {
      set((state) => {
        try {
          const document = hydrateWorkflowGraphDocument(project.document);
          if (!document) {
            throw new Error(
              "Workflow project contains an invalid graph document.",
            );
          }
          const nextSnapshot = WorkflowEngine.hydrate(
            document,
            DEFAULT_WORKFLOW_ACTIVITY,
          );

          applySnapshotToState(state, nextSnapshot);
          state.activeRunId = null;
          state.documentRevision = project.documentRevision;
          state.isStreamingExecutionStatus = false;
          state.lockedNodeIds = [];
          state.localDocumentVersion = 0;
          state.lastExecutionFinishedAt = null;
          state.lastKnownCredits = null;
          state.lastServerRuntime = null;
          state.projectId = project.id;
          resetHistory(state);
          state.ready = true;
        } catch (error) {
          state.activeRunId = null;
          state.documentRevision = null;
          state.isStreamingExecutionStatus = false;
          state.lockedNodeIds = [];
          state.localDocumentVersion = 0;
          state.lastExecutionFinishedAt = null;
          state.lastKnownCredits = null;
          state.lastServerRuntime = null;
          applySnapshotToState(state, WorkflowEngine.createInitialState());
          state.projectId = null;
          resetHistory(state);
          state.ready = true;
          state.runtime.activity = getErrorMessage(error);
        }
      });
    },

    applyServerExecutionState: (executionState) => {
      set((state) => {
        const currentSnapshot = snapshotFromState(state);

        runSnapshotMutation(
          state,
          () =>
            WorkflowEngine.syncState({
              document: mergeExecutionTargetResults(
                currentSnapshot.document,
                executionState,
              ),
              editor: currentSnapshot.editor,
              runtime: mergeExecutionRuntimeState(
                currentSnapshot.runtime,
                executionState,
              ),
            }),
          { persistDocument: false, recordHistory: false },
        );

        state.activeRunId = isWorkflowRunActiveStatus(executionState.status)
          ? executionState.runId
          : null;
        state.lockedNodeIds = isWorkflowRunLockingStatus(executionState.status)
          ? executionState.targetNodeIds
          : [];
        state.isStreamingExecutionStatus = isWorkflowRunActiveStatus(
          executionState.status,
        );
        state.documentRevision =
          executionState.projectDocumentRevision ?? state.documentRevision;
        state.lastExecutionFinishedAt = executionState.runtime.finishedAt;
        state.lastKnownCredits =
          executionState.credits ?? state.lastKnownCredits;
        state.lastServerRuntime = executionState.runtime;
      });
    },

    clearActiveRunId: () => {
      set((state) => {
        state.activeRunId = null;
        state.isStreamingExecutionStatus = false;
        state.lockedNodeIds = [];
      });
    },

    setProjectPersistence: (documentRevision) => {
      set((state) => {
        state.documentRevision = documentRevision;
      });
    },

    setActivity: (activity) => {
      set((state) => {
        state.runtime.activity = activity;
      });
    },

    setActiveRunId: (runId) => {
      set((state) => {
        state.activeRunId = runId;
      });
    },

    setExecutionStreaming: (isStreaming) => {
      set((state) => {
        state.isStreamingExecutionStatus = isStreaming;
      });
    },

    setNodeRuntimeState: (nodeId, status, error) => {
      set((state) => {
        const currentSnapshot = snapshotFromState(state);
        runSnapshotMutation(
          state,
          () =>
            WorkflowEngine.syncState({
              ...currentSnapshot,
              runtime: updateRuntimeNodeState(
                currentSnapshot.runtime,
                nodeId,
                (nodeState) => ({
                  ...nodeState,
                  error,
                  status,
                }),
              ),
            }),
          { recordHistory: false },
        );
      });
    },

    updateDocumentNode: (nodeId, updater) => {
      set((state) => {
        if (
          getLockedExecutionNodeIds(state.document, state.lockedNodeIds).has(
            nodeId,
          )
        ) {
          state.runtime.activity = LOCKED_WORKFLOW_ACTIVITY;
          return;
        }

        const currentSnapshot = snapshotFromState(state);
        runSnapshotMutation(state, () =>
          WorkflowEngine.syncState({
            ...currentSnapshot,
            document: updateWorkflowDocumentNode(
              currentSnapshot.document,
              nodeId,
              updater,
            ),
          }),
        );
      });
    },

    setListItems: (nodeId, items) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "list" ? ListNodeService.setItems(node, items) : node,
      );
    },

    setLaneReorderMode: (nodeId, mode) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "laneReorder"
          ? LaneReorderNodeService.setMode(node, mode)
          : node,
      );
    },

    setLaneReorderOrder: (nodeId, order) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "laneReorder"
          ? LaneReorderNodeService.setOrder(node, order)
          : node,
      );
    },

    setLaneReorderShift: (nodeId, shift) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "laneReorder"
          ? LaneReorderNodeService.setShift(node, shift)
          : node,
      );
    },

    setLaneReorderValueType: (nodeId, valueType) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "laneReorder"
          ? LaneReorderNodeService.setValueType(node, valueType)
          : node,
      );
    },

    setLaneSelectIndices: (nodeId, indices) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "laneSelect"
          ? LaneSelectNodeService.setIndices(node, indices)
          : node,
      );
    },

    setLaneSplitCount: (nodeId, splitCount) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "laneSplit"
          ? LaneSplitNodeService.setSplitCount(node, splitCount)
          : node,
      );
    },

    setLaneZipAlignMode: (nodeId, mode) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "laneZipAlign"
          ? LaneZipAlignNodeService.setMode(node, mode)
          : node,
      );
    },

    setPrompt: (nodeId, prompt) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "prompt"
          ? PromptNodeService.setPrompt(node, prompt)
          : node,
      );
    },

    setPromptDisplayMode: (nodeId, displayMode) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "prompt"
          ? PromptNodeService.setDisplayMode(node, displayMode)
          : node,
      );
    },

    addPromptVariable: (nodeId) => {
      let createdVariable: PromptVariable | null = null;

      set((state) => {
        const currentSnapshot = snapshotFromState(state);
        runSnapshotMutation(state, () => {
          const document = updateWorkflowDocumentNode(
            currentSnapshot.document,
            nodeId,
            (node) => {
              if (node.kind !== "prompt") {
                return node;
              }

              const result = PromptNodeService.addVariable(node);
              createdVariable = result.variable;
              return result.node;
            },
          );

          return WorkflowEngine.syncState({
            ...currentSnapshot,
            document,
          });
        });
      });

      return createdVariable;
    },

    setImageGeneratorModel: (nodeId, model) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "imageGenerator"
          ? ImageGeneratorService.setModel(node, model)
          : node,
      );
    },

    setVideoGeneratorModel: (nodeId, model) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "videoGenerator"
          ? VideoGeneratorService.setModel(node, model)
          : node,
      );
    },

    setImageGeneratorMode: (nodeId, mode) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "imageGenerator"
          ? ImageGeneratorService.setMode(node, mode)
          : node,
      );
    },

    setVideoGeneratorMode: (nodeId, mode) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "videoGenerator"
          ? VideoGeneratorService.setMode(node, mode)
          : node,
      );
    },

    setImageGeneratorConfigValue: (nodeId, key, value) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "imageGenerator"
          ? ImageGeneratorService.setConfigValue(node, key, value)
          : node,
      );
    },

    setLlmGeneratorConfigValue: (nodeId, key, value) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "llmGenerator"
          ? LlmGeneratorService.setConfigValue(node, key, value)
          : node,
      );
    },

    setVideoGeneratorConfigValue: (nodeId, key, value) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "videoGenerator"
          ? VideoGeneratorService.setConfigValue(node, key, value)
          : node,
      );
    },

    setGeneratorReviewEnabled: (nodeId, enabled) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "imageGenerator" ||
        node.kind === "videoGenerator" ||
        node.kind === "llmGenerator"
          ? { ...node, reviewEnabled: enabled }
          : node,
      );
    },

    setNodePosition: (nodeId, position, options) => {
      set((state) => {
        if (
          getLockedExecutionNodeIds(state.document, state.lockedNodeIds).has(
            nodeId,
          )
        ) {
          state.runtime.activity = LOCKED_WORKFLOW_ACTIVITY;
          return;
        }

        const currentSnapshot = snapshotFromState(state);
        const currentNode = currentSnapshot.document.nodes.find(
          (candidate) => candidate.id === nodeId,
        );

        if (
          !currentNode ||
          (currentNode.position.x === position.x &&
            currentNode.position.y === position.y)
        ) {
          return;
        }

        runSnapshotMutation(
          state,
          () =>
            WorkflowEngine.syncState({
              ...currentSnapshot,
              document: updateWorkflowDocumentNode(
                currentSnapshot.document,
                nodeId,
                (node) => ({
                  ...node,
                  position,
                }),
              ),
            }),
          {
            recordHistory: options?.recordHistory,
          },
        );
      });
    },

    clearNodeAssets: (nodeId) => {
      set((state) => {
        const currentSnapshot = snapshotFromState(state);
        runSnapshotMutation(state, () =>
          WorkflowEngine.syncState({
            ...currentSnapshot,
            document: updateWorkflowDocumentNode(
              currentSnapshot.document,
              nodeId,
              (node) => WorkflowNodeAssetService.clearAssets(node),
            ),
            runtime: updateRuntimeNodeState(
              currentSnapshot.runtime,
              nodeId,
              () => createWorkflowNodeRuntimeState(),
            ),
          }),
        );
      });
    },

    applyNodeChanges: (changes) => {
      set((state) => {
        const nextNodes = applyReactFlowNodeChanges(
          changes,
          state.nodes,
        ) as WorkflowCanvasNode[];
        const relevantChanges = changes.filter(
          (change) => change.type !== "dimensions",
        );

        if (!relevantChanges.length) {
          state.nodes = nextNodes;
          syncSelectedNodeIdsFromCanvas(state, nextNodes);
          syncNodeDimensionsFromCanvas(state, nextNodes);
          return;
        }

        const currentSnapshot = snapshotFromState(state);
        const lockedExecutionNodeIds = getLockedExecutionNodeIds(
          currentSnapshot.document,
          state.lockedNodeIds,
        );

        if (
          relevantChanges.some(
            (change) =>
              "id" in change &&
              change.type !== "select" &&
              lockedExecutionNodeIds.has(change.id),
          )
        ) {
          state.runtime.activity = LOCKED_WORKFLOW_ACTIVITY;
          return;
        }

        state.nodes = nextNodes;
        syncNodeDimensionsFromCanvas(state, nextNodes);

        const hasDraggingPositionChange = relevantChanges.some(
          (change) => change.type === "position" && change.dragging === true,
        );
        const hasDragStopPositionChange = relevantChanges.some(
          (change) => change.type === "position" && change.dragging === false,
        );
        const hasNonSelectionChange = relevantChanges.some(
          (change) => change.type !== "select",
        );
        const hasSelectionAndPositionOnlyChanges = relevantChanges.every(
          (change) => change.type === "position" || change.type === "select",
        );

        // React Flow emits every movement while dragging; keep the pre-drag
        // snapshot so undo collapses the whole drag into one step.
        if (hasDraggingPositionChange && !state.pendingNodeDragHistoryEntry) {
          state.pendingNodeDragHistoryEntry =
            createHistoryEntry(currentSnapshot);
        }

        // Keep drag movement transient in canvas state and only commit once on
        // drag stop so document subscribers (drawer, persistence) don't churn
        // every frame.
        if (
          hasDraggingPositionChange &&
          !hasDragStopPositionChange &&
          hasSelectionAndPositionOnlyChanges
        ) {
          syncSelectedNodeIdsFromCanvas(state, nextNodes);
          return;
        }

        const snapshotWithMeasurements = {
          ...currentSnapshot,
          editor: {
            ...currentSnapshot.editor,
            nodeDimensionsById: state.editor.nodeDimensionsById,
          },
        } satisfies WorkflowStudioSnapshot;

        const snapshotForNodeChanges = hasDragStopPositionChange
          ? {
              ...snapshotWithMeasurements,
              document: syncDocumentNodePositionsFromCanvas(
                snapshotWithMeasurements.document,
                nextNodes,
              ),
            }
          : snapshotWithMeasurements;

        runSnapshotMutation(
          state,
          () =>
            WorkflowEngine.applyNodeChanges(
              snapshotForNodeChanges,
              relevantChanges,
            ),
          hasDraggingPositionChange || hasDragStopPositionChange
            ? {
                historyEntry: hasDragStopPositionChange
                  ? (state.pendingNodeDragHistoryEntry ??
                    createHistoryEntry(currentSnapshot))
                  : undefined,
                recordHistory:
                  hasDraggingPositionChange && !hasDragStopPositionChange
                    ? false
                    : undefined,
              }
            : hasNonSelectionChange
              ? undefined
              : {
                  recordHistory: false,
                },
        );

        if (hasDragStopPositionChange) {
          state.pendingNodeDragHistoryEntry = null;
        }
      });
    },

    applyEdgeChanges: (changes) => {
      set((state) => {
        const currentSnapshot = snapshotFromState(state);
        const hasNonSelectionChange = changes.some(
          (change) => change.type !== "select",
        );
        const lockedExecutionNodeIds = getLockedExecutionNodeIds(
          currentSnapshot.document,
          state.lockedNodeIds,
        );
        const edgeById = new Map(
          currentSnapshot.document.edges.map((edge) => [edge.id, edge]),
        );

        if (
          changes.some((change) => {
            if (change.type === "select" || !("id" in change)) {
              return false;
            }

            const edge = edgeById.get(change.id);
            return Boolean(
              edge &&
                (lockedExecutionNodeIds.has(edge.source) ||
                  lockedExecutionNodeIds.has(edge.target)),
            );
          })
        ) {
          state.runtime.activity = LOCKED_WORKFLOW_ACTIVITY;
          return;
        }

        runSnapshotMutation(
          state,
          () => WorkflowEngine.applyEdgeChanges(currentSnapshot, changes),
          hasNonSelectionChange
            ? undefined
            : {
                recordHistory: false,
              },
        );
      });
    },

    connect: (connection) => {
      set((state) => {
        const lockedExecutionNodeIds = getLockedExecutionNodeIds(
          state.document,
          state.lockedNodeIds,
        );

        if (
          (connection.source &&
            lockedExecutionNodeIds.has(connection.source)) ||
          (connection.target && lockedExecutionNodeIds.has(connection.target))
        ) {
          state.runtime.activity = LOCKED_WORKFLOW_ACTIVITY;
          return;
        }

        const currentSnapshot = snapshotFromState(state);
        runSnapshotMutation(state, () =>
          WorkflowEngine.connect(currentSnapshot, connection),
        );
      });
    },

    canConnect: (connection) =>
      WorkflowEngine.canConnect(get().document, connection),

    addNode: (kind, position) => {
      let addedNodeId: string | null = null;

      set((state) => {
        const currentSnapshot = snapshotFromState(state);
        const previousNodeIds = new Set(
          currentSnapshot.document.nodes.map((node) => node.id),
        );

        runSnapshotMutation(state, () =>
          WorkflowEngine.addNode(currentSnapshot, kind, position),
        );

        addedNodeId =
          state.document.nodes.find((node) => !previousNodeIds.has(node.id))
            ?.id ?? null;
      });

      return addedNodeId;
    },

    addConnectedNode: (params) => {
      set((state) => {
        const lockedExecutionNodeIds = getLockedExecutionNodeIds(
          state.document,
          state.lockedNodeIds,
        );

        if (lockedExecutionNodeIds.has(params.startHandle.nodeId)) {
          state.runtime.activity = LOCKED_WORKFLOW_ACTIVITY;
          return;
        }

        const currentSnapshot = snapshotFromState(state);
        runSnapshotMutation(state, () =>
          WorkflowEngine.addConnectedNode(currentSnapshot, params),
        );
      });
    },

    addAssetNodeAt: (position, assets) => {
      let addedNodeId: string | null = null;

      set((state) => {
        const currentSnapshot = snapshotFromState(state);
        const previousNodeIds = new Set(
          currentSnapshot.document.nodes.map((node) => node.id),
        );

        runSnapshotMutation(state, () =>
          WorkflowEngine.addAssetNodeAt(currentSnapshot, position, assets),
        );

        const addedNode = state.document.nodes.find(
          (node) => !previousNodeIds.has(node.id),
        );
        addedNodeId = addedNode?.kind === "asset" ? addedNode.id : null;
      });

      return addedNodeId;
    },

    clearSelection: () => {
      set((state) => {
        if (
          !state.editor.selectedNodeIds.length &&
          !state.editor.selectedEdgeIds.length
        ) {
          return;
        }

        state.pendingNodeDragHistoryEntry = null;
        const currentSnapshot = snapshotFromState(state);
        runSnapshotMutation(
          state,
          () =>
            WorkflowEngine.syncState({
              ...currentSnapshot,
              editor: {
                ...currentSnapshot.editor,
                selectedNodeIds: [],
                selectedEdgeIds: [],
              },
            }),
          {
            recordHistory: false,
          },
        );
      });
    },

    deleteSelection: () => {
      set((state) => {
        const lockedExecutionNodeIds = getLockedExecutionNodeIds(
          state.document,
          state.lockedNodeIds,
        );

        if (
          state.editor.selectedNodeIds.some((nodeId) =>
            lockedExecutionNodeIds.has(nodeId),
          ) ||
          state.document.edges.some(
            (edge) =>
              state.editor.selectedEdgeIds.includes(edge.id) &&
              (lockedExecutionNodeIds.has(edge.source) ||
                lockedExecutionNodeIds.has(edge.target)),
          )
        ) {
          state.runtime.activity = LOCKED_WORKFLOW_ACTIVITY;
          return;
        }

        const currentSnapshot = snapshotFromState(state);
        runSnapshotMutation(state, () =>
          WorkflowEngine.deleteSelection(currentSnapshot),
        );
      });
    },

    undo: () => {
      set((state) => {
        state.pendingNodeDragHistoryEntry = null;
        const previousEntry = state.history.past.pop();
        if (!previousEntry) {
          syncHistoryFlags(state);
          return;
        }

        state.history.future.push(createHistoryEntry(snapshotFromState(state)));

        try {
          restoreHistoryEntry(state, previousEntry);
          state.runtime.activity = "Undid last change.";
        } catch (error) {
          state.history.past.push(previousEntry);
          state.history.future.pop();
          state.runtime.activity = getErrorMessage(error);
        }

        syncHistoryFlags(state);
      });
    },

    redo: () => {
      set((state) => {
        state.pendingNodeDragHistoryEntry = null;
        const nextEntry = state.history.future.pop();
        if (!nextEntry) {
          syncHistoryFlags(state);
          return;
        }

        state.history.past.push(createHistoryEntry(snapshotFromState(state)));

        try {
          restoreHistoryEntry(state, nextEntry);
          state.runtime.activity = "Redid last change.";
        } catch (error) {
          state.history.future.push(nextEntry);
          state.history.past.pop();
          state.runtime.activity = getErrorMessage(error);
        }

        syncHistoryFlags(state);
      });
    },
  })),
);

export function useWorkflowStudioPersistence(project: WorkflowProject) {
  const hydrate = useWorkflowStudioStore((state) => state.hydrate);
  const projectId = useWorkflowStudioStore((state) => state.projectId);
  const ready = useWorkflowStudioStore((state) => state.ready);
  const localDocumentVersion = useWorkflowStudioStore(
    (state) => state.localDocumentVersion,
  );
  const hasHydratedProject = useRef(false);

  useEffect(() => {
    hasHydratedProject.current = false;
    hydrate(project);

    WorkflowPersistenceService.configure({
      getSnapshot: () => {
        const state = useWorkflowStudioStore.getState();
        if (
          !state.ready ||
          !state.projectId ||
          state.documentRevision === null
        ) {
          return null;
        }

        return {
          document: toWorkflowGraphDocument(state.document),
          documentRevision: state.documentRevision,
          projectId: state.projectId,
        };
      },
      onError: (error) => {
        useWorkflowStudioStore.getState().setActivity(getErrorMessage(error));
      },
      onSaved: (result) => {
        useWorkflowStudioStore
          .getState()
          .setProjectPersistence(result.documentRevision);
      },
    });

    return () => {
      WorkflowPersistenceService.reset();
    };
  }, [hydrate, project]);

  useEffect(() => {
    void localDocumentVersion;

    if (!ready || !projectId) {
      return;
    }

    if (!hasHydratedProject.current) {
      hasHydratedProject.current = true;
      return;
    }

    WorkflowPersistenceService.scheduleSave();
  }, [localDocumentVersion, projectId, ready]);

  useEffect(() => {
    if (!ready) {
      return;
    }

    const flushPendingSave = () => {
      void WorkflowPersistenceService.flushSave().catch((error) => {
        useWorkflowStudioStore.getState().setActivity(getErrorMessage(error));
      });
    };

    const handleVisibilityChange = () => {
      if (globalThis.document.visibilityState === "hidden") {
        flushPendingSave();
      }
    };

    window.addEventListener("pagehide", flushPendingSave);
    globalThis.document.addEventListener(
      "visibilitychange",
      handleVisibilityChange,
    );

    return () => {
      window.removeEventListener("pagehide", flushPendingSave);
      globalThis.document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
    };
  }, [ready]);
}
