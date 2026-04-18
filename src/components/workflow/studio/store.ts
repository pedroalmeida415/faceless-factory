"use client";

import { useEffect } from "react";
import {
	addEdge,
	applyEdgeChanges,
	applyNodeChanges,
	type Connection,
	type EdgeChange,
	type NodeChange,
} from "reactflow";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import type {
	ImageGeneratorNodeData,
	ImageIteratorNodeData,
	VideoGeneratorNodeData,
	WorkflowNodeData,
	WorkflowNodeKind,
} from "~/lib/workflow/types";
import {
	applyNodeUpdate,
	createDefaultDocument,
	createNode,
	createNodeId,
	formatDeletionActivity,
	formatNodeTitle,
	loadDocument,
	normalizeGeneratorImageTargetHandles,
	normalizeWorkflowDocument,
	STORAGE_KEY,
} from "./graph";
import type { WorkflowEdge, WorkflowNode } from "./types";

const DEFAULT_DOCUMENT = normalizeWorkflowDocument(createDefaultDocument());
const DEFAULT_ACTIVITY =
	"Connect prompt and media nodes into the generators. Local graph state auto-saves in your browser.";

type WorkflowStudioState = {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	activity: string;
	ready: boolean;
	hydrate: () => void;
	setActivity: (activity: string) => void;
	updateNodeData: (
		nodeId: string,
		updater: (data: WorkflowNodeData) => WorkflowNodeData,
	) => void;
	clearNodeAssets: (nodeId: string) => void;
	applyNodeChanges: (changes: NodeChange[]) => void;
	applyEdgeChanges: (changes: EdgeChange[]) => void;
	connect: (connection: Connection) => void;
	addNode: (kind: WorkflowNodeKind) => void;
	deleteSelection: () => void;
	resetGraph: () => void;
};

export const useWorkflowStudioStore = create<WorkflowStudioState>()(
	immer((set) => ({
		nodes: DEFAULT_DOCUMENT.nodes,
		edges: DEFAULT_DOCUMENT.edges,
		activity: DEFAULT_ACTIVITY,
		ready: false,

		hydrate: () => {
			const loaded = loadDocument();
			set((state) => {
				state.nodes = loaded.nodes;
				state.edges = loaded.edges;
				state.ready = true;
			});
		},

		setActivity: (activity) => {
			set((state) => {
				state.activity = activity;
			});
		},

		updateNodeData: (nodeId, updater) => {
			set((state) => {
				state.nodes = applyNodeUpdate(state.nodes, nodeId, updater);
			});
		},

		clearNodeAssets: (nodeId) => {
			set((state) => {
				state.nodes = applyNodeUpdate(state.nodes, nodeId, (current) => {
					switch (current.kind) {
						case "image":
							return { ...current, asset: null, status: "idle", error: null };
						case "video":
							return { ...current, asset: null, status: "idle", error: null };
						case "imageIterator":
							return { ...current, assets: [], status: "idle", error: null };
						case "imageGenerator":
						case "videoGenerator":
							return {
								...current,
								outputAssets: [],
								status: "idle",
								error: null,
							};
						default:
							return current;
					}
				});
			});
		},

		applyNodeChanges: (changes) => {
			set((state) => {
				state.nodes = applyNodeChanges(changes, state.nodes) as WorkflowNode[];
			});
		},

		applyEdgeChanges: (changes) => {
			set((state) => {
				state.edges = normalizeGeneratorImageTargetHandles(
					state.nodes,
					applyEdgeChanges(changes, state.edges) as WorkflowEdge[],
				);
			});
		},

		connect: (connection) => {
			set((state) => {
				state.edges = normalizeGeneratorImageTargetHandles(
					state.nodes,
					addEdge(
						{
							...connection,
							id: createNodeId(),
							type: "smoothstep",
							animated: false,
							style: { stroke: "rgba(226, 232, 240, 0.55)", strokeWidth: 2 },
						},
						state.edges,
					) as WorkflowEdge[],
				);
			});
		},

		addNode: (kind) => {
			set((state) => {
				state.nodes = [...state.nodes, createNode(kind, state.nodes.length)];
				state.activity = `${formatNodeTitle(kind)} node added.`;
			});
		},

		deleteSelection: () => {
			set((state) => {
				const selectedNodeIds = new Set(
					state.nodes.filter((node) => node.selected).map((node) => node.id),
				);
				const selectedEdgeIds = new Set(
					state.edges.filter((edge) => edge.selected).map((edge) => edge.id),
				);

				if (!selectedNodeIds.size && !selectedEdgeIds.size) {
					state.activity = "Nothing selected to delete.";
					return;
				}

				const edgeIdsToRemove = new Set(
					state.edges
						.filter(
							(edge) =>
								selectedEdgeIds.has(edge.id) ||
								selectedNodeIds.has(edge.source) ||
								selectedNodeIds.has(edge.target),
						)
						.map((edge) => edge.id),
				);

				state.nodes = state.nodes.filter(
					(node) => !selectedNodeIds.has(node.id),
				);
				state.edges = normalizeGeneratorImageTargetHandles(
					state.nodes,
					state.edges.filter((edge) => !edgeIdsToRemove.has(edge.id)),
				);
				state.activity = formatDeletionActivity(
					selectedNodeIds.size,
					edgeIdsToRemove.size,
				);
			});
		},

		resetGraph: () => {
			const defaults = normalizeWorkflowDocument(createDefaultDocument());
			set((state) => {
				state.nodes = defaults.nodes;
				state.edges = defaults.edges;
				state.activity = "Workflow reset to the starter graph.";
			});

			if (typeof window !== "undefined") {
				window.localStorage.removeItem(STORAGE_KEY);
			}
		},
	})),
);

export function useWorkflowStudioPersistence() {
	const hydrate = useWorkflowStudioStore((state) => state.hydrate);
	const ready = useWorkflowStudioStore((state) => state.ready);
	const nodes = useWorkflowStudioStore((state) => state.nodes);
	const edges = useWorkflowStudioStore((state) => state.edges);

	useEffect(() => {
		hydrate();
	}, [hydrate]);

	useEffect(() => {
		if (!ready || typeof window === "undefined") {
			return;
		}

		window.localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				version: 1,
				nodes,
				edges,
			}),
		);
	}, [edges, nodes, ready]);
}

export function setNodeStatus(
	nodeId: string,
	status: WorkflowNodeData["status"],
	error: string | null,
) {
	useWorkflowStudioStore.getState().updateNodeData(nodeId, (current) => ({
		...current,
		status,
		error,
	}));
}

export function setImageGeneratorResult(
	nodeId: string,
	updater: (current: ImageGeneratorNodeData) => ImageGeneratorNodeData,
) {
	useWorkflowStudioStore
		.getState()
		.updateNodeData(nodeId, (current) =>
			current.kind === "imageGenerator" ? updater(current) : current,
		);
}

export function setVideoGeneratorResult(
	nodeId: string,
	updater: (current: VideoGeneratorNodeData) => VideoGeneratorNodeData,
) {
	useWorkflowStudioStore
		.getState()
		.updateNodeData(nodeId, (current) =>
			current.kind === "videoGenerator" ? updater(current) : current,
		);
}

export function setImageIteratorAssets(
	nodeId: string,
	updater: (current: ImageIteratorNodeData) => ImageIteratorNodeData,
) {
	useWorkflowStudioStore
		.getState()
		.updateNodeData(nodeId, (current) =>
			current.kind === "imageIterator" ? updater(current) : current,
		);
}
