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
	const activity = useWorkflowStudioStore((state) => state.activity);
	const addNode = useWorkflowStudioStore((state) => state.addNode);
	const connect = useWorkflowStudioStore((state) => state.connect);
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
	const { contextValue, runSelectedOrAll } = useWorkflowStudioController();

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Delete") {
				return;
			}

			if (isEditableTarget(event.target)) {
				return;
			}

			event.preventDefault();
			deleteSelection();
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [deleteSelection]);

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
			<div className="min-h-screen bg-[radial-gradient(circle_at_top_left,#18324d,transparent_40%),radial-gradient(circle_at_top_right,#3f2335,transparent_30%),linear-gradient(180deg,#050816,#0b1022)] text-white">
				<div className="mx-auto flex min-h-screen max-w-[1800px] gap-6 px-5 py-5">
					<WorkflowSidebar
						activity={activity}
						onAddNode={addNodeToCanvas}
						onReset={handleReset}
						onRun={() => void runSelectedOrAll()}
					/>

					<main className="min-w-0 flex-1 overflow-hidden rounded-[36px] border border-white/10 bg-black/15 shadow-[0_40px_120px_rgba(0,0,0,0.45)] backdrop-blur">
						<div className="flex items-center justify-between border-white/10 border-b px-6 py-5">
							<div>
								<div className="text-[11px] text-slate-400 uppercase tracking-[0.32em]">
									Canvas
								</div>
								<h2 className="mt-1 font-semibold text-2xl">
									Prompt to image/video workflow graph
								</h2>
							</div>
							<div className="flex items-center gap-2 text-slate-300 text-xs">
								<span className="rounded-full border border-white/10 bg-white/6 px-3 py-2">
									Local graph autosave
								</span>
								<span className="rounded-full border border-white/10 bg-white/6 px-3 py-2">
									Vertex-backed generators
								</span>
							</div>
						</div>

						<div className="h-[calc(100vh-4rem)] min-h-[780px]">
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
						</div>
					</main>
				</div>
			</div>
		</StudioContext.Provider>
	);
}
