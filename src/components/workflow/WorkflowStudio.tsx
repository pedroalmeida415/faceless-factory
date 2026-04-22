"use client";

import {
  RiArrowGoBackLine,
  RiArrowGoForwardLine,
  RiFullscreenFill,
} from "@remixicon/react";
import { memo, useCallback, useEffect, useRef } from "react";
import {
  Background,
  ConnectionLineType,
  ReactFlow,
  type ReactFlowInstance,
  useReactFlow,
} from "reactflow";
import { Card, CardContent } from "~/components/ui/card";
import { WORKFLOW_GRID_STEP } from "~/lib/workflow/document";
import type { WorkflowProject } from "~/lib/workflow/project";
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
const WORKFLOW_SNAP_GRID: [number, number] = [
  WORKFLOW_GRID_STEP,
  WORKFLOW_GRID_STEP,
];

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
  flowRef,
}: {
  flowRef: { current: ReactFlowInstance | null };
}) {
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

  const handleFlowInit = useCallback(
    (instance: ReactFlowInstance) => {
      flowRef.current = instance;
      requestAnimationFrame(() => instance.fitView({ padding: 0.18 }));
    },
    [flowRef],
  );

  return (
    <Card className="h-full min-w-0 overflow-hidden rounded-[28px] border-border/60 py-0 md:min-h-[calc(100vh-2.5rem)]">
      <CardContent className="h-full p-0">
        <ReactFlow
          connectionLineType={ConnectionLineType.SmoothStep}
          defaultEdgeOptions={WORKFLOW_DEFAULT_EDGE_OPTIONS}
          deleteKeyCode={null}
          edges={edges}
          fitView
          isValidConnection={canConnect}
          nodes={nodes}
          nodeTypes={nodeTypes}
          onConnect={connect}
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
      </CardContent>
    </Card>
  );
});

export function WorkflowStudio({ project }: { project: WorkflowProject }) {
  useWorkflowStudioPersistence(project);

  const flowRef = useRef<ReactFlowInstance | null>(null);
  const addNode = useWorkflowStudioStore((state) => state.addNode);
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

      if (event.key !== "Delete") {
        return;
      }

      event.preventDefault();
      deleteCurrentSelection();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const addNodeToCanvas = useCallback(
    (kind: Parameters<typeof addNode>[0]) => {
      addNode(kind);
      requestAnimationFrame(() => flowRef.current?.fitView({ padding: 0.18 }));
    },
    [addNode],
  );

  return (
    <StudioContext.Provider value={contextValue}>
      <div className="relative h-screen p-2">
        <WorkflowCreditsBadge />
        <WorkflowSidebar onAddNode={addNodeToCanvas} />
        <WorkflowNodeConfigDrawer />
        <WorkflowCanvas flowRef={flowRef} />
      </div>
    </StudioContext.Provider>
  );
}
