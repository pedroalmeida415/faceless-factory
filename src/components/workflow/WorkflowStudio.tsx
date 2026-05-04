"use client";

import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  RiArrowGoBackLine,
  RiArrowGoForwardLine,
  RiFullscreenFill,
} from "@remixicon/react";
import {
  Background,
  type Connection,
  ConnectionLineType,
  type IsValidConnection,
  type OnConnectEnd,
  type OnConnectStart,
  type OnInit,
  ReactFlow,
  type ReactFlowInstance,
  useReactFlow,
} from "@xyflow/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "~/components/ui/autocomplete";
import { Card, CardContent } from "~/components/ui/card";
import {
  createWorkflowNode,
  snapWorkflowPositionToGrid,
  specializeWorkflowNodeForValueType,
  WORKFLOW_GRID_STEP,
  type WorkflowDocument,
  type WorkflowPosition,
} from "~/lib/workflow/document";
import {
  findFirstWorkflowHandleIdByValueType,
  getWorkflowHandleValueType,
  type WorkflowHandleReference,
} from "~/lib/workflow/graph";
import {
  formatNodeTitle,
  type WorkflowValueType,
} from "~/lib/workflow/node-definitions";
import { PromptNodeService } from "~/lib/workflow/services/node-services";
import type {
  WorkflowCanvasEdge,
  WorkflowCanvasNode,
} from "~/lib/workflow/studio-state";
import type { WorkflowStudioView } from "~/lib/workflow/studio-view";
import type { WorkflowNodeKind } from "~/lib/workflow/types";
import { AssetLibrary } from "./studio/AssetLibrary";
import { getWorkflowAssetDropData } from "./studio/asset-dnd";
import { WorkflowCreditsBadge } from "./studio/CreditsBadge";
import { StudioContext } from "./studio/context";
import { isEditableTarget } from "./studio/graph";
import { WorkflowNodeConfigDrawer } from "./studio/NodeConfigDrawer";
import { nodeTypes } from "./studio/nodes";
import { WorkflowSidebar } from "./studio/Sidebar";
import { ShellButton } from "./studio/shared";
import {
  useWorkflowStudioPersistence,
  useWorkflowStudioStore,
} from "./studio/store";
import { useWorkflowStudioController } from "./studio/useWorkflowStudioController";

const WORKFLOW_DEFAULT_EDGE_OPTIONS = {
  type: "smoothstep",
  style: {
    stroke: "rgba(226, 232, 240, 0.55)",
    strokeWidth: 2,
  },
} as const;

const WORKFLOW_PRO_OPTIONS = { hideAttribution: true } as const;
const WORKFLOW_DELETE_KEYS = new Set(["Backspace", "Delete"]);
const WORKFLOW_SNAP_GRID: [number, number] = [
  WORKFLOW_GRID_STEP,
  WORKFLOW_GRID_STEP,
];
const WORKFLOW_CONNECTION_AUTOCOMPLETE_WIDTH = 320;
const WORKFLOW_CONNECTION_AUTOCOMPLETE_MARGIN = 16;
const WORKFLOW_CONNECTION_AUTOCOMPLETE_SIDE_THRESHOLD = 320;
const WORKFLOW_NODE_KINDS: WorkflowNodeKind[] = [
  "list",
  "prompt",
  "asset",
  "outputReorder",
  "llmGenerator",
  "imageGenerator",
  "videoGenerator",
];

type ConnectionAutocompleteOption = {
  kind: WorkflowNodeKind;
  label: string;
};

type ConnectionAutocompleteState = {
  flowPosition: { x: number; y: number };
  popupPosition: { x: number; y: number };
  popupSide: "top" | "bottom";
  options: ConnectionAutocompleteOption[];
  startHandle: WorkflowHandleReference;
  valueType: WorkflowValueType;
};

type PendingNodeCenter = {
  center: WorkflowPosition;
  nodeId: string;
};

function getEventClientPosition(event: MouseEvent | TouchEvent) {
  if ("changedTouches" in event) {
    const touch = event.changedTouches[0] ?? event.touches[0];
    return touch
      ? {
          x: touch.clientX,
          y: touch.clientY,
        }
      : null;
  }

  return {
    x: event.clientX,
    y: event.clientY,
  };
}

function clampAutocompletePosition(position: { x: number; y: number }) {
  const maxX = Math.max(
    WORKFLOW_CONNECTION_AUTOCOMPLETE_MARGIN,
    window.innerWidth -
      WORKFLOW_CONNECTION_AUTOCOMPLETE_WIDTH -
      WORKFLOW_CONNECTION_AUTOCOMPLETE_MARGIN,
  );
  const maxY = Math.max(
    WORKFLOW_CONNECTION_AUTOCOMPLETE_MARGIN,
    window.innerHeight - 48 - WORKFLOW_CONNECTION_AUTOCOMPLETE_MARGIN,
  );

  return {
    x: Math.min(
      Math.max(position.x, WORKFLOW_CONNECTION_AUTOCOMPLETE_MARGIN),
      maxX,
    ),
    y: Math.min(
      Math.max(position.y, WORKFLOW_CONNECTION_AUTOCOMPLETE_MARGIN),
      maxY,
    ),
  };
}

function buildConnectionAutocompleteOptions(params: {
  document: WorkflowDocument;
  flowPosition: { x: number; y: number };
  startHandle: WorkflowHandleReference;
  valueType: WorkflowValueType;
}) {
  return WORKFLOW_NODE_KINDS.flatMap((kind) => {
    const specializedNode = specializeWorkflowNodeForValueType(
      createWorkflowNode(
        kind,
        params.document.nodes.length,
        params.flowPosition,
      ),
      params.valueType,
    );
    const candidateNode =
      specializedNode.kind === "prompt" &&
      params.startHandle.handleType === "source" &&
      params.valueType === "text"
        ? PromptNodeService.seedTextVariable(specializedNode).node
        : specializedNode;
    const documentWithCandidate = {
      ...params.document,
      nodes: [...params.document.nodes, candidateNode],
    };
    const compatibleHandleId = findFirstWorkflowHandleIdByValueType(
      documentWithCandidate,
      {
        nodeId: candidateNode.id,
        handleType:
          params.startHandle.handleType === "source" ? "target" : "source",
        valueType: params.valueType,
      },
    );

    return compatibleHandleId
      ? [
          {
            kind,
            label: formatNodeTitle(kind),
          } satisfies ConnectionAutocompleteOption,
        ]
      : [];
  });
}

function WorkflowConnectionAutocomplete({
  onClose,
  onSelect,
  state,
}: {
  onClose: () => void;
  onSelect: (kind: WorkflowNodeKind) => void;
  state: ConnectionAutocompleteState;
}) {
  const [value, setValue] = useState("");

  return (
    <div
      className="fixed z-50 w-80"
      style={{
        left: state.popupPosition.x,
        top: state.popupPosition.y,
      }}
    >
      <Autocomplete
        autoHighlight="always"
        itemToStringValue={(item: ConnectionAutocompleteOption) => item.label}
        items={state.options}
        modal={false}
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
        onValueChange={setValue}
        open
        openOnInputClick
        value={value}
      >
        <AutocompleteInput
          autoFocus
          className="w-full rounded-full border-border/60 bg-background/92 shadow-2xl backdrop-blur-xl"
          placeholder={`Add a ${state.valueType} node...`}
          showClear
        />
        <AutocompletePopup
          className="w-80"
          side={state.popupSide}
          sideOffset={8}
        >
          <AutocompleteEmpty>No compatible nodes</AutocompleteEmpty>
          <AutocompleteList>
            {(item: ConnectionAutocompleteOption) => (
              <AutocompleteItem
                key={item.kind}
                onClick={() => onSelect(item.kind)}
                value={item}
              >
                <div className="flex w-full items-center justify-between gap-3">
                  <span>{item.label}</span>
                  <span className="text-muted-foreground text-xs uppercase">
                    {state.valueType}
                  </span>
                </div>
              </AutocompleteItem>
            )}
          </AutocompleteList>
        </AutocompletePopup>
      </Autocomplete>
    </div>
  );
}

function WorkflowCanvasControls({
  onRedo,
  onUndo,
  canRedo,
  canUndo,
}: {
  onRedo: () => void;
  onUndo: () => void;
  canRedo: boolean;
  canUndo: boolean;
}) {
  const reactFlow = useReactFlow();

  return (
    <div className="pointer-events-none absolute right-1/2 bottom-2 z-20 flex translate-x-1/2 justify-center">
      <Card className="pointer-events-auto rounded-full border-border/60 bg-background/88 py-2 shadow-2xl backdrop-blur-xl">
        <CardContent className="flex items-center gap-2 px-2 py-0">
          <ShellButton
            aria-label="Zoom in"
            className="size-9 rounded-full border-border/60 bg-background/70 p-0 text-foreground"
            onClick={() => void reactFlow.zoomIn({ duration: 180 })}
            size="icon"
            title="Zoom in"
          >
            +
          </ShellButton>
          <ShellButton
            aria-label="Zoom out"
            className="size-9 rounded-full border-border/60 bg-background/70 p-0 text-foreground"
            onClick={() => void reactFlow.zoomOut({ duration: 180 })}
            size="icon"
            title="Zoom out"
          >
            -
          </ShellButton>
          <ShellButton
            aria-label="Fit view"
            className="size-9 rounded-full border-border/60 bg-background/70 p-0 text-foreground"
            onClick={() =>
              void reactFlow.fitView({ duration: 180, padding: 0.18 })
            }
            size="icon"
            title="Fit view"
          >
            <RiFullscreenFill className="size-4" />
          </ShellButton>
          <ShellButton
            aria-label="Undo"
            className="size-9 rounded-full border-border/60 bg-background/70 p-0 text-foreground"
            disabled={!canUndo}
            onClick={onUndo}
            size="icon"
            title="Undo"
          >
            <RiArrowGoBackLine className="size-4" />
          </ShellButton>
          <ShellButton
            aria-label="Redo"
            className="size-9 rounded-full border-border/60 bg-background/70 p-0 text-foreground"
            disabled={!canRedo}
            onClick={onRedo}
            size="icon"
            title="Redo"
          >
            <RiArrowGoForwardLine className="size-4" />
          </ShellButton>
        </CardContent>
      </Card>
    </div>
  );
}

const WorkflowCanvas = memo(function WorkflowCanvas({
  canvasRef,
  flowRef,
  queueNodeCenter,
  onRequestConnectionAutocomplete,
}: {
  canvasRef: { current: HTMLDivElement | null };
  flowRef: {
    current: ReactFlowInstance<WorkflowCanvasNode, WorkflowCanvasEdge> | null;
  };
  queueNodeCenter: (center: WorkflowPosition, nodeId: string) => void;
  onRequestConnectionAutocomplete: (
    state: ConnectionAutocompleteState | null,
  ) => void;
}) {
  const document = useWorkflowStudioStore((state) => state.document);
  const nodes = useWorkflowStudioStore((state) => state.nodes);
  const edges = useWorkflowStudioStore((state) => state.edges);
  const connect = useWorkflowStudioStore((state) => state.connect);
  const canConnect = useWorkflowStudioStore((state) => state.canConnect);
  const applyNodeChanges = useWorkflowStudioStore(
    (state) => state.applyNodeChanges,
  );
  const applyEdgeChanges = useWorkflowStudioStore(
    (state) => state.applyEdgeChanges,
  );
  const undo = useWorkflowStudioStore((state) => state.undo);
  const redo = useWorkflowStudioStore((state) => state.redo);
  const canUndo = useWorkflowStudioStore((state) => state.canUndo);
  const canRedo = useWorkflowStudioStore((state) => state.canRedo);
  const pendingStartHandleRef = useRef<WorkflowHandleReference | null>(null);
  const didConnectRef = useRef(false);
  const addAssetNodeAt = useWorkflowStudioStore(
    (state) => state.addAssetNodeAt,
  );

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) {
      return;
    }

    return dropTargetForElements({
      canDrop: ({ source }) => Boolean(getWorkflowAssetDropData(source.data)),
      element,
      onDrop: ({ location, source }) => {
        const payload = getWorkflowAssetDropData(source.data);
        const flow = flowRef.current;
        if (!payload || !flow) {
          return;
        }

        const center = flow.screenToFlowPosition({
          x: location.current.input.clientX,
          y: location.current.input.clientY,
        });
        const nodeId = addAssetNodeAt(center, [payload.asset]);

        if (!nodeId) {
          return;
        }

        queueNodeCenter(center, nodeId);
      },
    });
  }, [addAssetNodeAt, canvasRef.current, flowRef, queueNodeCenter]);

  const handleFlowInit: OnInit<WorkflowCanvasNode, WorkflowCanvasEdge> =
    useCallback(
      (instance) => {
        flowRef.current = instance;
        requestAnimationFrame(() => instance.fitView({ padding: 0.18 }));
      },
      [flowRef],
    );

  const isValidConnection: IsValidConnection<WorkflowCanvasEdge> = useCallback(
    (connection) =>
      canConnect({
        source: connection.source,
        sourceHandle: connection.sourceHandle ?? null,
        target: connection.target,
        targetHandle: connection.targetHandle ?? null,
      }),
    [canConnect],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      didConnectRef.current = true;
      pendingStartHandleRef.current = null;
      onRequestConnectionAutocomplete(null);
      connect(connection);
    },
    [connect, onRequestConnectionAutocomplete],
  );

  const handleConnectStart = useCallback<OnConnectStart>(
    (_event, params) => {
      didConnectRef.current = false;
      pendingStartHandleRef.current =
        params.nodeId && params.handleType
          ? {
              nodeId: params.nodeId,
              handleId: params.handleId ?? null,
              handleType: params.handleType,
            }
          : null;
      onRequestConnectionAutocomplete(null);
    },
    [onRequestConnectionAutocomplete],
  );

  const handleConnectEnd = useCallback<OnConnectEnd>(
    (event: MouseEvent | TouchEvent) => {
      const startHandle = pendingStartHandleRef.current;
      pendingStartHandleRef.current = null;

      if (!startHandle || didConnectRef.current) {
        didConnectRef.current = false;
        onRequestConnectionAutocomplete(null);
        return;
      }

      didConnectRef.current = false;

      const clientPosition = getEventClientPosition(event);
      if (!clientPosition) {
        onRequestConnectionAutocomplete(null);
        return;
      }

      const valueType = getWorkflowHandleValueType(document, startHandle);

      if (!valueType) {
        onRequestConnectionAutocomplete(null);
        return;
      }

      const flowPosition =
        flowRef.current?.screenToFlowPosition(clientPosition);
      if (!flowPosition) {
        onRequestConnectionAutocomplete(null);
        return;
      }

      const options = buildConnectionAutocompleteOptions({
        document,
        flowPosition,
        startHandle,
        valueType,
      });

      if (!options.length) {
        onRequestConnectionAutocomplete(null);
        return;
      }

      onRequestConnectionAutocomplete({
        flowPosition,
        popupPosition: clampAutocompletePosition(clientPosition),
        popupSide:
          clientPosition.y >
          window.innerHeight - WORKFLOW_CONNECTION_AUTOCOMPLETE_SIDE_THRESHOLD
            ? "top"
            : "bottom",
        options,
        startHandle,
        valueType,
      });
    },
    [document, flowRef, onRequestConnectionAutocomplete],
  );

  return (
    <Card className="h-full min-w-0 overflow-hidden rounded-[28px] border-border/60 py-0 md:min-h-[calc(100vh-2.5rem)]">
      <CardContent className="h-full p-0">
        <div className="h-full" ref={canvasRef}>
          <ReactFlow
            connectionLineType={ConnectionLineType.SmoothStep}
            defaultEdgeOptions={WORKFLOW_DEFAULT_EDGE_OPTIONS}
            deleteKeyCode={null}
            edges={edges}
            fitView
            isValidConnection={isValidConnection}
            nodes={nodes}
            nodeTypes={nodeTypes}
            onConnect={handleConnect}
            onConnectEnd={handleConnectEnd}
            onConnectStart={handleConnectStart}
            onEdgesChange={applyEdgeChanges}
            onInit={handleFlowInit}
            onNodesChange={applyNodeChanges}
            proOptions={WORKFLOW_PRO_OPTIONS}
            snapGrid={WORKFLOW_SNAP_GRID}
            snapToGrid
          >
            <Background
              color="rgba(148, 163, 184, 0.16)"
              gap={WORKFLOW_GRID_STEP}
            />
            <WorkflowCanvasControls
              canRedo={canRedo}
              canUndo={canUndo}
              onRedo={redo}
              onUndo={undo}
            />
          </ReactFlow>
        </div>
      </CardContent>
    </Card>
  );
});

export function WorkflowStudio({ view }: { view: WorkflowStudioView }) {
  useWorkflowStudioPersistence(view);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<
    WorkflowCanvasNode,
    WorkflowCanvasEdge
  > | null>(null);
  const [isAssetLibraryOpen, setIsAssetLibraryOpen] = useState(false);
  const addNode = useWorkflowStudioStore((state) => state.addNode);
  const addConnectedNode = useWorkflowStudioStore(
    (state) => state.addConnectedNode,
  );
  const nodes = useWorkflowStudioStore((state) => state.nodes);
  const setNodePosition = useWorkflowStudioStore(
    (state) => state.setNodePosition,
  );
  const nodeDimensionsById = useWorkflowStudioStore(
    (state) => state.editor.nodeDimensionsById,
  );
  const [connectionAutocomplete, setConnectionAutocomplete] =
    useState<ConnectionAutocompleteState | null>(null);
  const [pendingNodeCenters, setPendingNodeCenters] = useState<
    PendingNodeCenter[]
  >([]);
  const { contextValue } = useWorkflowStudioController();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }

      const {
        deleteSelection: deleteCurrentSelection,
        redo: redoChange,
        undo: undoChange,
      } = useWorkflowStudioStore.getState();

      const key = event.key.toLowerCase();
      const modifierPressed = event.metaKey || event.ctrlKey;

      if (modifierPressed && !event.shiftKey && key === "z") {
        event.preventDefault();
        undoChange();
        return;
      }

      if (modifierPressed && ((event.shiftKey && key === "z") || key === "y")) {
        event.preventDefault();
        redoChange();
        return;
      }

      if (!WORKFLOW_DELETE_KEYS.has(event.key)) {
        return;
      }

      event.preventDefault();
      deleteCurrentSelection();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!pendingNodeCenters.length) {
      return;
    }

    const canvasNodeIds = new Set(nodes.map((node) => node.id));
    const readyNodeIds = new Set(
      pendingNodeCenters.flatMap(({ nodeId }) =>
        !canvasNodeIds.has(nodeId) || nodeDimensionsById[nodeId]
          ? [nodeId]
          : [],
      ),
    );

    if (!readyNodeIds.size) {
      return;
    }

    setPendingNodeCenters((currentCenters) =>
      currentCenters.filter(({ nodeId }) => !readyNodeIds.has(nodeId)),
    );

    for (const { center, nodeId } of pendingNodeCenters) {
      if (!readyNodeIds.has(nodeId)) {
        continue;
      }

      const dimensions = nodeDimensionsById[nodeId];
      if (!dimensions) {
        continue;
      }

      setNodePosition(
        nodeId,
        snapWorkflowPositionToGrid({
          x: center.x - dimensions.width / 2,
          y: center.y - dimensions.height / 2,
        }),
        { recordHistory: false },
      );
    }
  }, [nodeDimensionsById, nodes, pendingNodeCenters, setNodePosition]);

  const getViewportCenter = useCallback(() => {
    const flow = flowRef.current;
    const canvas = canvasRef.current;
    if (!flow || !canvas) {
      return null;
    }

    const bounds = canvas.getBoundingClientRect();
    return flow.screenToFlowPosition({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    });
  }, []);

  const queueNodeCenter = useCallback(
    (center: WorkflowPosition, nodeId: string) => {
      setPendingNodeCenters((currentCenters) => [
        ...currentCenters,
        { center, nodeId },
      ]);
    },
    [],
  );

  const addNodeToCanvas = useCallback(
    (kind: Parameters<typeof addNode>[0]) => {
      const center = getViewportCenter();
      setConnectionAutocomplete(null);
      const nodeId = addNode(kind, center ?? undefined);

      if (center && nodeId) {
        queueNodeCenter(center, nodeId);
      }
    },
    [addNode, getViewportCenter, queueNodeCenter],
  );

  const handleConnectionAutocompleteSelect = useCallback(
    (kind: WorkflowNodeKind) => {
      if (!connectionAutocomplete) {
        return;
      }

      addConnectedNode({
        kind,
        position: connectionAutocomplete.flowPosition,
        startHandle: connectionAutocomplete.startHandle,
        valueType: connectionAutocomplete.valueType,
      });
      setConnectionAutocomplete(null);
    },
    [addConnectedNode, connectionAutocomplete],
  );

  return (
    <StudioContext.Provider value={contextValue}>
      <div className="relative h-screen p-2">
        <WorkflowCreditsBadge />
        <WorkflowSidebar
          isAssetLibraryOpen={isAssetLibraryOpen}
          onAddNode={addNodeToCanvas}
          onToggleAssetLibrary={() =>
            setIsAssetLibraryOpen((currentOpen) => !currentOpen)
          }
        />
        <AssetLibrary
          onOpenChange={setIsAssetLibraryOpen}
          open={isAssetLibraryOpen}
          projectId={view.project.id}
        />
        <WorkflowNodeConfigDrawer />
        <WorkflowCanvas
          canvasRef={canvasRef}
          flowRef={flowRef}
          queueNodeCenter={queueNodeCenter}
          onRequestConnectionAutocomplete={setConnectionAutocomplete}
        />
        {connectionAutocomplete ? (
          <WorkflowConnectionAutocomplete
            onClose={() => setConnectionAutocomplete(null)}
            onSelect={handleConnectionAutocompleteSelect}
            state={connectionAutocomplete}
          />
        ) : null}
      </div>
    </StudioContext.Provider>
  );
}
