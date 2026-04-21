"use client";

import { useEffect } from "react";
import type { Connection, EdgeChange, NodeChange } from "reactflow";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import {
  updateWorkflowDocumentNode,
  type WorkflowDocument,
  type WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { getErrorMessage } from "~/lib/workflow/errors";
import { toWorkflowStudioRuntimeState } from "~/lib/workflow/execution/runtime-state";
import type {
  WorkflowCreditsSummary,
  WorkflowExecutionRuntimeState,
  WorkflowExecutionStatusResponse,
} from "~/lib/workflow/execution/types";
import {
  ImageGeneratorService,
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
  VideoGeneratorModelId,
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
  state.document = snapshot.document;
  state.editor = snapshot.editor;
  state.runtime = snapshot.runtime;

  const canvas = buildWorkflowCanvas(snapshot);
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

function createHistoryState(): WorkflowHistoryState {
  return {
    future: [],
    past: [],
  };
}

function serializeWorkflowDocument(document: WorkflowDocument) {
  return JSON.stringify(document);
}

function cloneWorkflowDocument(document: WorkflowDocument): WorkflowDocument {
  return JSON.parse(serializeWorkflowDocument(document)) as WorkflowDocument;
}

function createHistoryEntry(
  snapshot: WorkflowStudioSnapshot,
): WorkflowHistoryEntry {
  return {
    document: cloneWorkflowDocument(snapshot.document),
    selectedEdgeIds: [...snapshot.editor.selectedEdgeIds],
    selectedNodeIds: [...snapshot.editor.selectedNodeIds],
  };
}

function isSameWorkflowDocument(
  left: WorkflowDocument,
  right: WorkflowDocument,
) {
  return serializeWorkflowDocument(left) === serializeWorkflowDocument(right);
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

function commitSnapshot(
  state: WorkflowStudioState,
  nextSnapshot: WorkflowStudioSnapshot,
  options: {
    historyEntry?: WorkflowHistoryEntry;
    recordHistory?: boolean;
  } = {},
) {
  const previousSnapshot = snapshotFromState(state);
  const historyEntry =
    options.historyEntry ?? createHistoryEntry(previousSnapshot);
  const documentChanged = !isSameWorkflowDocument(
    historyEntry.document,
    nextSnapshot.document,
  );

  if (options.recordHistory !== false && documentChanged) {
    pushHistoryEntry(state, historyEntry);
  }

  applySnapshotToState(state, nextSnapshot);
  syncHistoryFlags(state);
}

function runSnapshotMutation(
  state: WorkflowStudioState,
  buildNextSnapshot: () => WorkflowStudioSnapshot,
  options?: {
    historyEntry?: WorkflowHistoryEntry;
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
  applySnapshotToState(
    state,
    WorkflowEngine.syncState({
      document: cloneWorkflowDocument(entry.document),
      editor: {
        selectedEdgeIds: [...entry.selectedEdgeIds],
        selectedNodeIds: [...entry.selectedNodeIds],
        nodeDimensionsById: state.editor.nodeDimensionsById,
      },
      runtime: state.runtime,
    }),
  );
}

const initialSnapshot = WorkflowEngine.createInitialState();
const initialCanvas = buildWorkflowCanvas(initialSnapshot);

type WorkflowStudioState = {
  document: WorkflowDocument;
  editor: WorkflowEditorState;
  runtime: WorkflowRuntimeState;
  activeRunId: string | null;
  isStreamingExecutionStatus: boolean;
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
  hydrate: () => void;
  applyServerExecutionState: (
    executionState: WorkflowExecutionStatusResponse,
  ) => void;
  clearActiveRunId: () => void;
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
  setPrompt: (nodeId: string, prompt: string) => void;
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
  setVideoGeneratorConfigValue: (
    nodeId: string,
    key: string,
    value: GeneratorConfigValue,
  ) => void;
  clearNodeAssets: (nodeId: string) => void;
  applyNodeChanges: (changes: NodeChange[]) => void;
  applyEdgeChanges: (changes: EdgeChange[]) => void;
  connect: (connection: Connection) => void;
  canConnect: (connection: Connection) => boolean;
  addNode: (kind: WorkflowNodeKind) => void;
  deleteSelection: () => void;
  undo: () => void;
  redo: () => void;
};

export const useWorkflowStudioStore = create<WorkflowStudioState>()(
  immer((set, get) => ({
    document: initialSnapshot.document,
    editor: initialSnapshot.editor,
    runtime: initialSnapshot.runtime,
    activeRunId: null,
    isStreamingExecutionStatus: false,
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

    hydrate: () => {
      set((state) => {
        try {
          const loadResult = WorkflowPersistenceService.loadDocument();
          const nextSnapshot = WorkflowEngine.hydrate(
            loadResult.document,
            loadResult.activity ?? DEFAULT_WORKFLOW_ACTIVITY,
          );

          applySnapshotToState(state, nextSnapshot);
          state.activeRunId = null;
          state.isStreamingExecutionStatus = false;
          state.lastExecutionFinishedAt = null;
          state.lastKnownCredits = null;
          state.lastServerRuntime = null;
          resetHistory(state);
          state.ready = true;
        } catch (error) {
          state.activeRunId = null;
          state.isStreamingExecutionStatus = false;
          state.lastExecutionFinishedAt = null;
          state.lastKnownCredits = null;
          state.lastServerRuntime = null;
          applySnapshotToState(state, WorkflowEngine.createInitialState());
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
              document: executionState.document,
              editor: currentSnapshot.editor,
              runtime: toWorkflowStudioRuntimeState(executionState.runtime),
            }),
          { recordHistory: false },
        );

        state.activeRunId =
          executionState.status === "queued" ||
          executionState.status === "running"
            ? executionState.runId
            : null;
        state.isStreamingExecutionStatus =
          executionState.status === "queued" ||
          executionState.status === "running";
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

    setPrompt: (nodeId, prompt) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "prompt"
          ? PromptNodeService.setPrompt(node, prompt)
          : node,
      );
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

    setVideoGeneratorConfigValue: (nodeId, key, value) => {
      get().updateDocumentNode(nodeId, (node) =>
        node.kind === "videoGenerator"
          ? VideoGeneratorService.setConfigValue(node, key, value)
          : node,
      );
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
        const currentSnapshot = snapshotFromState(state);
        const hasDraggingPositionChange = changes.some(
          (change) => change.type === "position" && change.dragging === true,
        );
        const hasDragStopPositionChange = changes.some(
          (change) => change.type === "position" && change.dragging === false,
        );

        // React Flow emits every movement while dragging; keep the pre-drag
        // snapshot so undo collapses the whole drag into one step.
        if (hasDraggingPositionChange && !state.pendingNodeDragHistoryEntry) {
          state.pendingNodeDragHistoryEntry =
            createHistoryEntry(currentSnapshot);
        }

        runSnapshotMutation(
          state,
          () => WorkflowEngine.applyNodeChanges(currentSnapshot, changes),
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
            : undefined,
        );

        if (hasDragStopPositionChange) {
          state.pendingNodeDragHistoryEntry = null;
        }
      });
    },

    applyEdgeChanges: (changes) => {
      set((state) => {
        const currentSnapshot = snapshotFromState(state);
        runSnapshotMutation(state, () =>
          WorkflowEngine.applyEdgeChanges(currentSnapshot, changes),
        );
      });
    },

    connect: (connection) => {
      set((state) => {
        const currentSnapshot = snapshotFromState(state);
        runSnapshotMutation(state, () =>
          WorkflowEngine.connect(currentSnapshot, connection),
        );
      });
    },

    canConnect: (connection) =>
      WorkflowEngine.canConnect(get().document, connection),

    addNode: (kind) => {
      set((state) => {
        const currentSnapshot = snapshotFromState(state);
        runSnapshotMutation(state, () =>
          WorkflowEngine.addNode(currentSnapshot, kind),
        );
      });
    },

    deleteSelection: () => {
      set((state) => {
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

export function useWorkflowStudioPersistence() {
  const hydrate = useWorkflowStudioStore((state) => state.hydrate);
  const ready = useWorkflowStudioStore((state) => state.ready);
  const document = useWorkflowStudioStore((state) => state.document);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!ready) {
      return;
    }

    try {
      WorkflowPersistenceService.saveDocument(document);
    } catch (error) {
      useWorkflowStudioStore.getState().setActivity(getErrorMessage(error));
    }
  }, [document, ready]);
}
