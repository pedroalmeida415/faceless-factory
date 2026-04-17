import type { Edge, Node } from "reactflow";

import {
	isGeneratorNodeKind,
	NANO_BANANA_PRO_MODEL_ID,
	type SavedWorkflowDocument,
	VEO_31_MODEL_ID,
	type WorkflowAsset,
	type WorkflowEdge,
	type WorkflowNode,
	type WorkflowNodeData,
	type WorkflowNodeKind,
} from "~/lib/workflow/types";

export const STORAGE_KEY = "faceless-factory.workflow.v1";
export const PROMPT_INPUT_HANDLE_ID = "prompt";
const GENERATOR_IMAGE_INPUT_HANDLE_PREFIX = "image-input-";
const LEGACY_GENERATOR_IMAGE_INPUT_HANDLE_IDS = new Set(["image", "images"]);
const GENERATOR_IMAGE_INPUT_COLOR = "#38bdf8";

export type RuntimeValue =
	| { type: "text"; text: string }
	| {
			type: "image";
			assets: WorkflowAsset[];
			iterationMode: "static" | "iterator";
	  }
	| { type: "video"; assets: WorkflowAsset[] };

type ImageRuntimeValue = Extract<RuntimeValue, { type: "image" }>;

export type ImageBatchPlan = {
	batches: WorkflowAsset[][];
	hasIterator: boolean;
	iterations: number;
};

export type GeneratorIterationInfo = {
	hasIterator: boolean;
	iterations: number;
	mismatchedIterators: boolean;
};

export type HandleDefinition = {
	id: string;
	label: string;
	color: string;
};

export function formatNodeTitle(kind: WorkflowNodeKind) {
	switch (kind) {
		case "prompt":
			return "Prompt";
		case "image":
			return "Image";
		case "video":
			return "Video";
		case "imageIterator":
			return "Image Iterator";
		case "imageGenerator":
			return "Image Generator";
		case "videoGenerator":
			return "Video Generator";
	}
}

function nextNodePosition(index: number) {
	const column = index % 3;
	const row = Math.floor(index / 3);

	return {
		x: 80 + column * 360,
		y: 80 + row * 290,
	};
}

export function createNodeId() {
	return crypto.randomUUID();
}

export function buildIncomingByTarget(edges: WorkflowEdge[]) {
	const incomingByTarget = new Map<string, WorkflowEdge[]>();

	for (const edge of edges) {
		const existing = incomingByTarget.get(edge.target) ?? [];
		existing.push(edge);
		incomingByTarget.set(edge.target, existing);
	}

	return incomingByTarget;
}

export function getIncomingEdgesForHandle(
	incomingByTarget: Map<string, WorkflowEdge[]>,
	targetId: string,
	handleId: string,
) {
	return (incomingByTarget.get(targetId) ?? []).filter(
		(edge) => edge.targetHandle === handleId,
	);
}

function makeGeneratorImageHandleId(index: number) {
	return `${GENERATOR_IMAGE_INPUT_HANDLE_PREFIX}${index}`;
}

export function isGeneratorImageHandle(handleId: string | null | undefined) {
	if (!handleId) {
		return false;
	}

	return (
		LEGACY_GENERATOR_IMAGE_INPUT_HANDLE_IDS.has(handleId) ||
		handleId.startsWith(GENERATOR_IMAGE_INPUT_HANDLE_PREFIX)
	);
}

export function getIncomingGeneratorImageEdges(
	incomingByTarget: Map<string, WorkflowEdge[]>,
	targetId: string,
) {
	return (incomingByTarget.get(targetId) ?? []).filter((edge) =>
		isGeneratorImageHandle(edge.targetHandle),
	);
}

export function getGeneratorImageInputHandles(
	edges: WorkflowEdge[],
	targetId: string,
): HandleDefinition[] {
	const connectedCount = edges.filter(
		(edge) =>
			edge.target === targetId && isGeneratorImageHandle(edge.targetHandle),
	).length;

	return Array.from({ length: connectedCount + 1 }, (_, index) => ({
		id: makeGeneratorImageHandleId(index),
		label: "Image",
		color: GENERATOR_IMAGE_INPUT_COLOR,
	}));
}

export function normalizeGeneratorImageTargetHandles(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
) {
	const nodeMap = new Map(nodes.map((node) => [node.id, node]));
	const nextImageHandleByTarget = new Map<string, number>();

	return edges.map((edge) => {
		const targetNode = nodeMap.get(edge.target);
		const targetData = targetNode?.data as WorkflowNodeData | undefined;
		if (!targetData || !isGeneratorNodeKind(targetData.kind)) {
			return edge;
		}

		if (!isGeneratorImageHandle(edge.targetHandle)) {
			return edge;
		}

		const nextIndex = nextImageHandleByTarget.get(edge.target) ?? 0;
		nextImageHandleByTarget.set(edge.target, nextIndex + 1);

		const targetHandle = makeGeneratorImageHandleId(nextIndex);
		return edge.targetHandle === targetHandle
			? edge
			: { ...edge, targetHandle };
	});
}

export function normalizeWorkflowDocument(
	document: SavedWorkflowDocument,
): SavedWorkflowDocument {
	return {
		...document,
		edges: normalizeGeneratorImageTargetHandles(document.nodes, document.edges),
	};
}

function toImageRuntimeValue(data: WorkflowNodeData): ImageRuntimeValue | null {
	switch (data.kind) {
		case "image":
			return data.asset
				? {
						type: "image",
						assets: [data.asset],
						iterationMode: "static",
					}
				: null;
		case "imageIterator":
			return {
				type: "image",
				assets: data.assets,
				iterationMode: "iterator",
			};
		case "imageGenerator":
			return data.outputAssets.length
				? {
						type: "image",
						assets: data.outputAssets,
						iterationMode: "static",
					}
				: null;
		default:
			return null;
	}
}

export function buildImageBatchPlan(
	values: Extract<RuntimeValue, { type: "image" }>[],
): ImageBatchPlan {
	const staticAssets = values.flatMap((value) =>
		value.iterationMode === "static" ? value.assets : [],
	);
	const iteratorValues = values.filter(
		(value) => value.iterationMode === "iterator",
	);

	if (!iteratorValues.length) {
		return {
			batches: [staticAssets],
			hasIterator: false,
			iterations: 1,
		};
	}

	const [firstIterator] = iteratorValues;
	if (!firstIterator?.assets.length) {
		throw new Error("Image iterator is empty.");
	}

	for (const iteratorValue of iteratorValues) {
		if (iteratorValue.assets.length !== firstIterator.assets.length) {
			throw new Error(
				"Connected image iterators must contain the same number of images.",
			);
		}
	}

	return {
		batches: firstIterator.assets.map((_, index) => [
			...staticAssets,
			...iteratorValues
				.map((iteratorValue) => iteratorValue.assets[index])
				.filter((asset): asset is WorkflowAsset => Boolean(asset)),
		]),
		hasIterator: true,
		iterations: firstIterator.assets.length,
	};
}

export function getGeneratorIterationPreview(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
	targetId: string,
): GeneratorIterationInfo {
	const nodeMap = new Map(nodes.map((node) => [node.id, node]));
	const incomingByTarget = buildIncomingByTarget(edges);
	const imageValues = getIncomingGeneratorImageEdges(incomingByTarget, targetId)
		.flatMap((edge) => {
			const sourceNode = nodeMap.get(edge.source);
			if (!sourceNode) {
				return [];
			}

			const imageValue = toImageRuntimeValue(
				sourceNode.data as WorkflowNodeData,
			);
			return imageValue ? [imageValue] : [];
		})
		.filter((value) => value.iterationMode === "iterator");

	if (!imageValues.length) {
		return {
			hasIterator: false,
			iterations: 1,
			mismatchedIterators: false,
		};
	}

	const iterationCounts = imageValues.map((value) => value.assets.length);
	const [firstCount = 0] = iterationCounts;
	const mismatchedIterators = iterationCounts.some(
		(count) => count !== firstCount,
	);

	return {
		hasIterator: true,
		iterations: mismatchedIterators ? Math.max(...iterationCounts) : firstCount,
		mismatchedIterators,
	};
}

function makeBaseNode(
	id: string,
	position: { x: number; y: number },
	data: WorkflowNodeData,
): WorkflowNode {
	return {
		id,
		type: data.kind,
		position,
		data,
		style: { width: 320 },
	};
}

export function createNode(
	kind: WorkflowNodeKind,
	index: number,
): WorkflowNode {
	const id = createNodeId();
	const position = nextNodePosition(index);

	switch (kind) {
		case "prompt":
			return makeBaseNode(id, position, {
				kind,
				label: "Prompt",
				status: "idle",
				error: null,
				prompt:
					"Hyperreal studio portrait of a chrome mannequin under cinematic rim light.",
			});
		case "image":
			return makeBaseNode(id, position, {
				kind,
				label: "Image Upload",
				status: "idle",
				error: null,
				asset: null,
			});
		case "video":
			return makeBaseNode(id, position, {
				kind,
				label: "Video Upload",
				status: "idle",
				error: null,
				asset: null,
			});
		case "imageIterator":
			return makeBaseNode(id, position, {
				kind,
				label: "Image Iterator",
				status: "idle",
				error: null,
				assets: [],
			});
		case "imageGenerator":
			return makeBaseNode(id, position, {
				kind,
				label: "Nano Banana Pro",
				status: "idle",
				error: null,
				model: NANO_BANANA_PRO_MODEL_ID,
				aspectRatio: "1:1",
				lastPrompt: "",
				responseText: null,
				outputAssets: [],
			});
		case "videoGenerator":
			return makeBaseNode(id, position, {
				kind,
				label: "Veo 3.1",
				status: "idle",
				error: null,
				model: VEO_31_MODEL_ID,
				aspectRatio: "16:9",
				durationSeconds: 4,
				generateAudio: true,
				resolution: "720p",
				lastPrompt: "",
				responseText: null,
				outputAssets: [],
			});
	}
}

export function createDefaultDocument(): SavedWorkflowDocument {
	const prompt = createNode("prompt", 0);
	const imageGenerator = createNode("imageGenerator", 1);
	const imageIterator = createNode("imageIterator", 2);
	const videoGenerator = createNode("videoGenerator", 3);
	const image = createNode("image", 4);
	const video = createNode("video", 5);

	imageGenerator.position = { x: 470, y: 70 };
	imageIterator.position = { x: 70, y: 350 };
	videoGenerator.position = { x: 470, y: 380 };
	image.position = { x: 70, y: 620 };
	video.position = { x: 470, y: 680 };

	return {
		version: 1,
		nodes: [
			prompt,
			imageGenerator,
			imageIterator,
			videoGenerator,
			image,
			video,
		],
		edges: [
			{
				id: createNodeId(),
				source: prompt.id,
				sourceHandle: "text",
				target: imageGenerator.id,
				targetHandle: "prompt",
				type: "smoothstep",
			},
			{
				id: createNodeId(),
				source: prompt.id,
				sourceHandle: "text",
				target: videoGenerator.id,
				targetHandle: "prompt",
				type: "smoothstep",
			},
		],
	};
}

export function loadDocument(): SavedWorkflowDocument {
	if (typeof window === "undefined") {
		return normalizeWorkflowDocument(createDefaultDocument());
	}

	const stored = window.localStorage.getItem(STORAGE_KEY);
	if (!stored) {
		return normalizeWorkflowDocument(createDefaultDocument());
	}

	try {
		const parsed = JSON.parse(stored) as SavedWorkflowDocument;
		if (parsed.version !== 1) {
			return normalizeWorkflowDocument(createDefaultDocument());
		}
		return normalizeWorkflowDocument(parsed);
	} catch {
		return normalizeWorkflowDocument(createDefaultDocument());
	}
}

export function applyNodeUpdate(
	nodes: WorkflowNode[],
	nodeId: string,
	updater: (data: WorkflowNodeData) => WorkflowNodeData,
) {
	return nodes.map((node) =>
		node.id === nodeId
			? { ...node, data: updater(node.data as WorkflowNodeData) }
			: node,
	);
}

export function isEditableTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) {
		return false;
	}

	return Boolean(
		target.closest(
			'input, textarea, select, [contenteditable="true"], [role="textbox"]',
		),
	);
}

export function formatDeletionActivity(nodeCount: number, edgeCount: number) {
	const parts: string[] = [];

	if (nodeCount > 0) {
		parts.push(`${nodeCount} node${nodeCount === 1 ? "" : "s"}`);
	}

	if (edgeCount > 0) {
		parts.push(`${edgeCount} connection${edgeCount === 1 ? "" : "s"}`);
	}

	if (!parts.length) {
		return "Nothing selected to delete.";
	}

	return `Deleted ${parts.join(" and ")}.`;
}

export type WorkflowCanvasNode = Node<WorkflowNodeData>;
export type WorkflowCanvasEdge = Edge;
