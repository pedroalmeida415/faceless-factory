"use client";

import { useCallback, useMemo } from "react";

import type {
	GenerateImageRequest,
	GenerateImageResponse,
	GenerateVideoRequest,
	GenerateVideoResponse,
	ImageGeneratorNodeData,
	UploadAssetResponse,
	VideoGeneratorNodeData,
	WorkflowNodeData,
} from "~/lib/workflow/types";
import { isGeneratorNodeKind } from "~/lib/workflow/types";
import { api } from "~/trpc/react";
import type { StudioContextValue } from "./context";
import {
	buildImageBatchPlan,
	buildIncomingByTarget,
	getGeneratorImageInputHandles,
	getGeneratorIterationPreview,
	getIncomingEdgesForHandle,
	getIncomingGeneratorImageEdges,
	PROMPT_INPUT_HANDLE_ID,
	type RuntimeValue,
} from "./graph";
import { useWorkflowStudioStore } from "./store";

export function useWorkflowStudioController() {
	const nodes = useWorkflowStudioStore((state) => state.nodes);
	const edges = useWorkflowStudioStore((state) => state.edges);
	const setActivity = useWorkflowStudioStore((state) => state.setActivity);
	const updateNodeData = useWorkflowStudioStore(
		(state) => state.updateNodeData,
	);
	const clearNodeAssets = useWorkflowStudioStore(
		(state) => state.clearNodeAssets,
	);

	const { mutateAsync: uploadAsset } = api.workflow.uploadAsset.useMutation();
	const { mutateAsync: generateImage } =
		api.workflow.generateImage.useMutation();
	const { mutateAsync: generateVideo } =
		api.workflow.generateVideo.useMutation();

	const getGeneratorIterationInfo = useCallback(
		(nodeId: string) => getGeneratorIterationPreview(nodes, edges, nodeId),
		[edges, nodes],
	);

	const getGeneratorImageInputs = useCallback(
		(nodeId: string) => getGeneratorImageInputHandles(edges, nodeId),
		[edges],
	);

	const uploadFilesToNode = useCallback(
		async (
			nodeId: string,
			files: File[],
			options: { kind: "image" | "video"; multiple: boolean },
		) => {
			updateNodeData(nodeId, (current) => ({
				...current,
				status: "running",
				error: null,
			}));
			setActivity(
				`Uploading ${files.length} ${options.kind}${files.length === 1 ? "" : "s"}...`,
			);

			try {
				const uploadedAssets = await Promise.all(
					files.map(async (file) => {
						const formData = new FormData();
						formData.append("file", file);
						const payload = await uploadAsset(formData);
						return (payload as UploadAssetResponse).asset;
					}),
				);

				updateNodeData(nodeId, (current) => {
					switch (current.kind) {
						case "image":
							return {
								...current,
								asset: uploadedAssets[0] ?? null,
								status: "success",
								error: null,
							};
						case "video":
							return {
								...current,
								asset: uploadedAssets[0] ?? null,
								status: "success",
								error: null,
							};
						case "imageIterator":
							return {
								...current,
								assets: options.multiple
									? [...current.assets, ...uploadedAssets]
									: uploadedAssets.slice(0, 1),
								status: "success",
								error: null,
							};
						default:
							return current;
					}
				});

				setActivity(
					`Uploaded ${uploadedAssets.length} ${options.kind}${uploadedAssets.length === 1 ? "" : "s"}.`,
				);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Upload failed unexpectedly.";
				updateNodeData(nodeId, (current) => ({
					...current,
					status: "error",
					error: message,
				}));
				setActivity(message);
			}
		},
		[setActivity, updateNodeData, uploadAsset],
	);

	const runNode = useCallback(
		async (nodeId: string) => {
			const snapshot = useWorkflowStudioStore.getState();
			const nodeMap = new Map(snapshot.nodes.map((node) => [node.id, node]));
			const incomingByTarget = buildIncomingByTarget(snapshot.edges);
			const pending = new Map<string, Promise<RuntimeValue>>();
			const activeStack = new Set<string>();

			const getInputValues = async (targetId: string, handleId: string) => {
				const incomingEdges = getIncomingEdgesForHandle(
					incomingByTarget,
					targetId,
					handleId,
				);
				return Promise.all(
					incomingEdges.map((edge) => evaluateNode(edge.source)),
				);
			};

			const coerceText = async (targetId: string) => {
				const values = await getInputValues(targetId, PROMPT_INPUT_HANDLE_ID);
				const prompt = values.find((value) => value.type === "text");
				if (!prompt?.text.trim()) {
					throw new Error("Connect a prompt node with text.");
				}
				return prompt.text.trim();
			};

			const coerceImageBatches = async (targetId: string) => {
				const incomingEdges = getIncomingGeneratorImageEdges(
					incomingByTarget,
					targetId,
				);
				const values = await Promise.all(
					incomingEdges.map((edge) => evaluateNode(edge.source)),
				);
				return buildImageBatchPlan(
					values.flatMap((value) => (value.type === "image" ? [value] : [])),
				);
			};

			const evaluateNode = async (currentId: string): Promise<RuntimeValue> => {
				const cached = pending.get(currentId);
				if (cached) {
					return cached;
				}

				const promise = (async (): Promise<RuntimeValue> => {
					if (activeStack.has(currentId)) {
						throw new Error("Cycle detected in workflow graph.");
					}

					activeStack.add(currentId);
					try {
						const currentNode = nodeMap.get(currentId);
						if (!currentNode) {
							throw new Error(`Node ${currentId} not found.`);
						}

						const data = currentNode.data as WorkflowNodeData;
						switch (data.kind) {
							case "prompt": {
								if (!data.prompt.trim()) {
									throw new Error("Prompt node is empty.");
								}
								return { type: "text", text: data.prompt };
							}
							case "image": {
								if (!data.asset) {
									throw new Error("Image node has no uploaded asset.");
								}
								return {
									type: "image",
									assets: [data.asset],
									iterationMode: "static",
								};
							}
							case "video": {
								if (!data.asset) {
									throw new Error("Video node has no uploaded asset.");
								}
								return { type: "video", assets: [data.asset] };
							}
							case "imageIterator": {
								if (!data.assets.length) {
									throw new Error("Image iterator is empty.");
								}
								return {
									type: "image",
									assets: data.assets,
									iterationMode: "iterator",
								};
							}
							case "imageGenerator": {
								updateNodeData(currentId, (current) => ({
									...(current as ImageGeneratorNodeData),
									status: "running",
									error: null,
								}));

								const prompt = await coerceText(currentId);
								const batchPlan = await coerceImageBatches(currentId);
								setActivity(
									batchPlan.hasIterator
										? `Running ${data.label} (${batchPlan.iterations} iterations)...`
										: `Running ${data.label}...`,
								);

								const responses = await Promise.all(
									batchPlan.batches.map((referenceImages) =>
										generateImage({
											prompt,
											referenceImages,
											aspectRatio: data.aspectRatio,
										} satisfies GenerateImageRequest),
									),
								);
								const generatedAssets = responses.flatMap(
									(payload) => (payload as GenerateImageResponse).assets,
								);
								const responseTextParts = responses
									.map((payload) => payload.responseText?.trim())
									.filter((value): value is string => Boolean(value));
								const responseText = responseTextParts.length
									? Array.from(new Set(responseTextParts)).join("\n\n")
									: null;

								updateNodeData(currentId, (current) => ({
									...(current as ImageGeneratorNodeData),
									status: "success",
									error: null,
									lastPrompt: prompt,
									responseText,
									outputAssets: generatedAssets,
								}));

								return {
									type: "image",
									assets: generatedAssets,
									iterationMode: "static",
								};
							}
							case "videoGenerator": {
								updateNodeData(currentId, (current) => ({
									...(current as VideoGeneratorNodeData),
									status: "running",
									error: null,
								}));

								const prompt = await coerceText(currentId);
								const batchPlan = await coerceImageBatches(currentId);
								setActivity(
									batchPlan.hasIterator
										? `Running ${data.label} (${batchPlan.iterations} iterations)...`
										: `Running ${data.label}...`,
								);

								const responses = await Promise.all(
									batchPlan.batches.map((referenceImages) =>
										generateVideo({
											prompt,
											referenceImages,
											aspectRatio: data.aspectRatio,
											durationSeconds: data.durationSeconds,
											generateAudio: data.generateAudio,
											resolution: data.resolution,
										} satisfies GenerateVideoRequest),
									),
								);
								const generatedAssets = responses.flatMap(
									(payload) => (payload as GenerateVideoResponse).assets,
								);

								updateNodeData(currentId, (current) => ({
									...(current as VideoGeneratorNodeData),
									status: "success",
									error: null,
									lastPrompt: prompt,
									responseText: null,
									outputAssets: generatedAssets,
								}));

								return {
									type: "video",
									assets: generatedAssets,
								};
							}
						}
					} catch (error) {
						const message =
							error instanceof Error ? error.message : "Node execution failed.";
						updateNodeData(currentId, (current) => ({
							...current,
							status: "error",
							error: message,
						}));
						throw error;
					} finally {
						activeStack.delete(currentId);
					}
				})();

				pending.set(currentId, promise);
				return promise;
			};

			try {
				await evaluateNode(nodeId);
				setActivity("Workflow run finished.");
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Workflow execution failed.";
				setActivity(message);
			}
		},
		[generateImage, generateVideo, setActivity, updateNodeData],
	);

	const runSelectedOrAll = useCallback(async () => {
		const currentNodes = useWorkflowStudioStore.getState().nodes;
		const selectedGeneratorIds = currentNodes
			.filter(
				(node) =>
					node.selected &&
					isGeneratorNodeKind((node.data as WorkflowNodeData).kind),
			)
			.map((node) => node.id);

		const targetIds =
			selectedGeneratorIds.length > 0
				? selectedGeneratorIds
				: currentNodes
						.filter((node) =>
							isGeneratorNodeKind((node.data as WorkflowNodeData).kind),
						)
						.map((node) => node.id);

		if (!targetIds.length) {
			setActivity("Add an image or video generator first.");
			return;
		}

		for (const targetId of targetIds) {
			await runNode(targetId);
		}
	}, [runNode, setActivity]);

	const contextValue = useMemo<StudioContextValue>(
		() => ({
			updateNodeData,
			uploadFilesToNode,
			clearNodeAssets,
			getGeneratorImageInputs,
			getGeneratorIterationInfo,
			runNode,
		}),
		[
			clearNodeAssets,
			getGeneratorImageInputs,
			getGeneratorIterationInfo,
			runNode,
			updateNodeData,
			uploadFilesToNode,
		],
	);

	return {
		contextValue,
		runSelectedOrAll,
	};
}
