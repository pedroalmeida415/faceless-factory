"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  Background,
  ConnectionLineType,
  Controls,
  MiniMap,
  ReactFlow,
  type ReactFlowInstance,
} from "reactflow";

import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { StudioContext } from "./studio/context";
import { isEditableTarget } from "./studio/graph";
import { nodeTypes } from "./studio/nodes";
import { WorkflowSidebar } from "./studio/Sidebar";
import {
  useWorkflowStudioPersistence,
  useWorkflowStudioStore,
} from "./studio/store";
import { useWorkflowStudioController } from "./studio/useWorkflowStudioController";

export function WorkflowStudio() {
  useWorkflowStudioPersistence();

  const flowRef = useRef<ReactFlowInstance | null>(null);
  const nodes = useWorkflowStudioStore((state) => state.nodes);
  const edges = useWorkflowStudioStore((state) => state.edges);
  const activity = useWorkflowStudioStore((state) => state.runtime.activity);
  const addNode = useWorkflowStudioStore((state) => state.addNode);
  const connect = useWorkflowStudioStore((state) => state.connect);
  const canConnect = useWorkflowStudioStore((state) => state.canConnect);
  const applyNodeChanges = useWorkflowStudioStore(
    (state) => state.applyNodeChanges,
  );
  const applyEdgeChanges = useWorkflowStudioStore(
    (state) => state.applyEdgeChanges,
  );
  const deleteSelection = useWorkflowStudioStore(
    (state) => state.deleteSelection,
  );
  const resetGraph = useWorkflowStudioStore((state) => state.resetGraph);
  const undo = useWorkflowStudioStore((state) => state.undo);
  const redo = useWorkflowStudioStore((state) => state.redo);
  const canUndo = useWorkflowStudioStore((state) => state.canUndo);
  const canRedo = useWorkflowStudioStore((state) => state.canRedo);
  const { contextValue, runSelectedOrAll } = useWorkflowStudioController();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      const modifierPressed = event.metaKey || event.ctrlKey;

      if (modifierPressed && !event.shiftKey && key === "z") {
        event.preventDefault();
        undo();
        return;
      }

      if (modifierPressed && ((event.shiftKey && key === "z") || key === "y")) {
        event.preventDefault();
        redo();
        return;
      }

      if (event.key !== "Delete") {
        return;
      }

      event.preventDefault();
      deleteSelection();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteSelection, redo, undo]);

  const addNodeToCanvas = useCallback(
    (kind: Parameters<typeof addNode>[0]) => {
      addNode(kind);
      requestAnimationFrame(() => flowRef.current?.fitView({ padding: 0.18 }));
    },
    [addNode],
  );

  const handleReset = useCallback(() => {
    resetGraph();
    requestAnimationFrame(() => flowRef.current?.fitView({ padding: 0.18 }));
  }, [resetGraph]);

  return (
    <StudioContext.Provider value={contextValue}>
      <div className="min-h-screen bg-background">
        <div className="mx-auto flex min-h-screen max-w-[1800px] gap-6 p-5">
          <WorkflowSidebar
            activity={activity}
            onAddNode={addNodeToCanvas}
            onRedo={redo}
            onReset={handleReset}
            onRun={() => void runSelectedOrAll()}
            onUndo={undo}
            canRedo={canRedo}
            canUndo={canUndo}
          />

          <Card className="min-w-0 flex-1 gap-0 overflow-hidden py-0">
            <CardHeader className="flex flex-row items-center justify-between border-b py-5">
              <div>
                <div className="text-muted-foreground text-[11px] uppercase tracking-[0.32em]">
                  Canvas
                </div>
                <CardTitle className="mt-1 text-2xl">
                  Prompt to image/video workflow graph
                </CardTitle>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <Badge variant="outline">Local graph autosave</Badge>
                <Badge variant="outline">Vertex-backed generators</Badge>
              </div>
            </CardHeader>

            <CardContent className="h-[calc(100vh-4rem)] min-h-[780px] p-0">
              <ReactFlow
                connectionLineType={ConnectionLineType.SmoothStep}
                defaultEdgeOptions={{
                  type: "smoothstep",
                  style: {
                    stroke: "rgba(226, 232, 240, 0.55)",
                    strokeWidth: 2,
                  },
                }}
                deleteKeyCode={null}
                edges={edges}
                fitView
                isValidConnection={canConnect}
                nodes={nodes}
                nodeTypes={nodeTypes}
                onConnect={connect}
                onEdgesChange={applyEdgeChanges}
                onInit={(instance) => {
                  flowRef.current = instance;
                  requestAnimationFrame(() =>
                    instance.fitView({ padding: 0.18 }),
                  );
                }}
                onNodesChange={applyNodeChanges}
                proOptions={{ hideAttribution: true }}
              >
                <Background color="rgba(148, 163, 184, 0.16)" gap={22} />
                <MiniMap
                  maskColor="rgba(2, 6, 23, 0.7)"
                  nodeColor={() => "rgba(226, 232, 240, 0.65)"}
                  style={{
                    background: "rgba(15, 23, 42, 0.82)",
                    border: "1px solid rgba(255,255,255,0.1)",
                  }}
                />
                <Controls
                  style={{
                    background: "rgba(15, 23, 42, 0.82)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    boxShadow: "none",
                  }}
                />
              </ReactFlow>
            </CardContent>
          </Card>
        </div>
      </div>
    </StudioContext.Provider>
  );
}
