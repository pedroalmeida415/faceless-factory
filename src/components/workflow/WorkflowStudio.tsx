"use client";

import Image from "next/image";
import {
	createContext,
	type PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	addEdge,
	Background,
	type Connection,
	ConnectionLineType,
	Controls,
	type Edge,
	Handle,
	MiniMap,
	type NodeProps,
	Position,
	ReactFlow,
	type ReactFlowInstance,
	useEdgesState,
	useNodesState,
} from "reactflow";

import {
	type GenerateImageRequest,
	type GenerateImageResponse,
	type GenerateVideoRequest,
	type GenerateVideoResponse,
	IMAGE_ASPECT_RATIOS,
	type ImageAspectRatio,
	type ImageGeneratorNodeData,
	type ImageIteratorNodeData,
	type ImageNodeData,
	isGeneratorNodeKind,
	NANO_BANANA_PRO_MODEL_ID,
	type PromptNodeData,
	type SavedWorkflowDocument,
	VEO_31_MODEL_ID,
	VIDEO_ASPECT_RATIOS,
	VIDEO_DURATIONS,
	VIDEO_RESOLUTIONS,
	type VideoAspectRatio,
	type VideoDuration,
	type VideoGeneratorNodeData,
	type VideoNodeData,
	type VideoResolution,
	type WorkflowAsset,
	type WorkflowEdge,
	type WorkflowNode,
	type WorkflowNodeData,
	type WorkflowNodeKind,
	type WorkflowNodeStatus,
} from "~/lib/workflow/types";

const STORAGE_KEY = "faceless-factory.workflow.v1";

type RuntimeValue =
	| { type: "text"; text: string }
	| { type: "image"; assets: WorkflowAsset[] }
	| { type: "video"; assets: WorkflowAsset[] };

type StudioContextValue = {
	updateNodeData: (
		nodeId: string,
		updater: (data: WorkflowNodeData) => WorkflowNodeData,
	) => void;
	uploadFilesToNode: (
		nodeId: string,
		files: File[],
		options: { kind: "image" | "video"; multiple: boolean },
	) => Promise<void>;
	clearNodeAssets: (nodeId: string) => void;
	runNode: (nodeId: string) => Promise<void>;
};

type HandleDefinition = {
	id: string;
	label: string;
	color: string;
};

const StudioContext = createContext<StudioContextValue | null>(null);

function useStudioContext() {
	const context = useContext(StudioContext);
	if (!context) {
		throw new Error("WorkflowStudio context missing.");
	}
	return context;
}

function formatNodeTitle(kind: WorkflowNodeKind) {
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

function createNodeId() {
	return crypto.randomUUID();
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

function createNode(kind: WorkflowNodeKind, index: number): WorkflowNode {
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

function createDefaultDocument(): SavedWorkflowDocument {
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

	const edges: WorkflowEdge[] = [
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
	];

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
		edges,
	};
}

function loadDocument(): SavedWorkflowDocument {
	if (typeof window === "undefined") {
		return createDefaultDocument();
	}

	const stored = window.localStorage.getItem(STORAGE_KEY);
	if (!stored) {
		return createDefaultDocument();
	}

	try {
		const parsed = JSON.parse(stored) as SavedWorkflowDocument;
		if (parsed.version !== 1) {
			return createDefaultDocument();
		}
		return parsed;
	} catch {
		return createDefaultDocument();
	}
}

function statusBadgeClass(status: WorkflowNodeStatus) {
	switch (status) {
		case "running":
			return "bg-amber-200/20 text-amber-100 ring-amber-100/30";
		case "success":
			return "bg-emerald-300/15 text-emerald-100 ring-emerald-200/25";
		case "error":
			return "bg-rose-300/15 text-rose-100 ring-rose-200/25";
		default:
			return "bg-white/8 text-slate-200 ring-white/10";
	}
}

function ShellButton(
	props: PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>,
) {
	const { children, className, ...rest } = props;
	return (
		<button
			className={`rounded-full border border-white/12 bg-white/8 px-3 py-2 text-sm text-white transition hover:border-white/20 hover:bg-white/14 ${className ?? ""}`}
			type="button"
			{...rest}
		>
			{children}
		</button>
	);
}

function AssetPreview({
	asset,
	className = "",
}: {
	asset: WorkflowAsset;
	className?: string;
}) {
	if (asset.kind === "image") {
		return (
			<div className="relative h-full w-full">
				<Image
					alt={asset.fileName}
					className={`rounded-2xl object-cover ${className}`}
					fill
					sizes="(max-width: 768px) 100vw, 320px"
					src={asset.url}
					unoptimized
				/>
			</div>
		);
	}

	return (
		<video
			className={`h-full w-full rounded-2xl object-cover ${className}`}
			controls
			preload="metadata"
			src={asset.url}
		>
			<track
				default
				kind="captions"
				label="No captions available"
				src="data:text/vtt,WEBVTT"
			/>
		</video>
	);
}

function OutputGallery({ assets }: { assets: WorkflowAsset[] }) {
	if (!assets.length) {
		return (
			<div className="rounded-2xl border border-white/12 border-dashed bg-black/15 px-3 py-4 text-slate-300 text-sm">
				No outputs yet.
			</div>
		);
	}

	return (
		<div className="grid grid-cols-2 gap-2">
			{assets.map((asset) => (
				<a
					className="group overflow-hidden rounded-2xl border border-white/10 bg-black/20"
					href={asset.url}
					key={asset.id}
					rel="noreferrer"
					target="_blank"
				>
					<div className="aspect-square bg-black/30">
						<AssetPreview asset={asset} />
					</div>
					<div className="border-white/10 border-t px-2 py-2 text-slate-200 text-xs">
						<div className="truncate">{asset.fileName}</div>
						<div className="text-[10px] text-slate-400 uppercase tracking-[0.24em]">
							{asset.source}
						</div>
					</div>
				</a>
			))}
		</div>
	);
}

function FilePickerButton({
	label,
	accept,
	multiple = false,
	onFiles,
}: {
	label: string;
	accept: string;
	multiple?: boolean;
	onFiles: (files: File[]) => void;
}) {
	const inputId = useId();

	return (
		<>
			<label
				className="inline-flex cursor-pointer items-center justify-center rounded-full border border-white/12 bg-white/10 px-3 py-2 text-sm text-white transition hover:border-white/25 hover:bg-white/16"
				htmlFor={inputId}
			>
				{label}
			</label>
			<input
				accept={accept}
				className="hidden"
				id={inputId}
				multiple={multiple}
				onChange={(event) => {
					const files = Array.from(event.target.files ?? []);
					if (files.length) {
						onFiles(files);
					}
					event.currentTarget.value = "";
				}}
				type="file"
			/>
		</>
	);
}

function NodeShell({
	children,
	data,
	icon,
	inputs = [],
	output = null,
	model = null,
	selected = false,
}: PropsWithChildren<{
	data: WorkflowNodeData;
	icon: string;
	inputs?: HandleDefinition[];
	output?: HandleDefinition | null;
	model?: string | null;
	selected?: boolean;
}>) {
	return (
		<div
			className={`relative rounded-[28px] border bg-[linear-gradient(180deg,rgba(15,23,42,0.94),rgba(3,7,18,0.9))] p-4 text-white backdrop-blur transition-[border-color,box-shadow,transform] duration-150 ${
				selected
					? "border-sky-300/80 shadow-[0_0_0_1px_rgba(125,211,252,0.4),0_0_0_10px_rgba(56,189,248,0.16),0_24px_80px_rgba(14,165,233,0.2)]"
					: "border-white/12 shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
			}`}
		>
			{inputs.map((input, index) => (
				<Handle
					id={input.id}
					key={input.id}
					position={Position.Left}
					style={{
						background: input.color,
						border: "2px solid rgba(255,255,255,0.9)",
						height: 14,
						left: -8,
						top: 92 + index * 30,
						width: 14,
					}}
					type="target"
				/>
			))}
			{output ? (
				<Handle
					id={output.id}
					position={Position.Right}
					style={{
						background: output.color,
						border: "2px solid rgba(255,255,255,0.9)",
						height: 14,
						right: -8,
						top: "50%",
						transform: "translateY(-50%)",
						width: 14,
					}}
					type="source"
				/>
			) : null}

			<div className="mb-4 flex items-start justify-between gap-4">
				<div className="space-y-2">
					<div className="flex items-center gap-2 text-[10px] text-slate-400 uppercase tracking-[0.28em]">
						<span>{formatNodeTitle(data.kind)}</span>
						{selected ? (
							<span className="rounded-full bg-sky-300/20 px-2 py-1 text-[10px] text-sky-100 ring-1 ring-sky-200/35">
								selected
							</span>
						) : null}
						<span
							className={`rounded-full px-2 py-1 ring-1 ${statusBadgeClass(data.status)}`}
						>
							{data.status}
						</span>
					</div>
					<h3 className="font-semibold text-lg text-white leading-tight">
						{data.label}
					</h3>
					{model ? <p className="text-slate-400 text-xs">{model}</p> : null}
				</div>
				<div className="rounded-2xl border border-white/10 bg-white/8 px-3 py-2 font-medium text-slate-100 text-xs tracking-[0.24em]">
					{icon}
				</div>
			</div>

			{inputs.length ? (
				<div className="mb-4 space-y-2">
					{inputs.map((input) => (
						<div
							className="flex items-center gap-2 text-[11px] text-slate-400 uppercase tracking-[0.22em]"
							key={input.id}
						>
							<span
								className="inline-block h-2 w-2 rounded-full"
								style={{ background: input.color }}
							/>
							<span>{input.label}</span>
						</div>
					))}
				</div>
			) : null}

			<div className="space-y-3">{children}</div>

			{data.error ? (
				<div className="mt-4 rounded-2xl border border-rose-200/20 bg-rose-300/10 px-3 py-3 text-rose-100 text-sm">
					{data.error}
				</div>
			) : null}
		</div>
	);
}

function PromptNode({ id, data, selected }: NodeProps<PromptNodeData>) {
	const { updateNodeData } = useStudioContext();

	return (
		<NodeShell
			data={data}
			icon="TXT"
			output={{ id: "text", label: "Text", color: "#f59e0b" }}
			selected={selected}
		>
			<textarea
				className="h-40 w-full resize-none rounded-3xl border border-white/10 bg-black/25 px-4 py-4 text-slate-100 text-sm outline-none placeholder:text-slate-500"
				onChange={(event) =>
					updateNodeData(id, (current) => ({
						...(current as PromptNodeData),
						prompt: event.target.value,
					}))
				}
				placeholder="Describe the shot, mood, framing, lens, motion."
				value={data.prompt}
			/>
		</NodeShell>
	);
}

function ImageUploadNode({ id, data, selected }: NodeProps<ImageNodeData>) {
	const { uploadFilesToNode, clearNodeAssets } = useStudioContext();

	return (
		<NodeShell
			data={data}
			icon="IMG"
			output={{ id: "image", label: "Image", color: "#38bdf8" }}
			selected={selected}
		>
			<div className="space-y-3">
				{data.asset ? (
					<div className="overflow-hidden rounded-3xl border border-white/10 bg-black/30">
						<div className="aspect-[4/3]">
							<AssetPreview asset={data.asset} />
						</div>
						<div className="flex items-center justify-between border-white/10 border-t px-3 py-3 text-slate-300 text-xs">
							<span className="truncate">{data.asset.fileName}</span>
							<ShellButton
								className="px-2 py-1 text-xs"
								onClick={() => clearNodeAssets(id)}
							>
								Clear
							</ShellButton>
						</div>
					</div>
				) : (
					<div className="rounded-3xl border border-white/14 border-dashed bg-black/20 px-4 py-8 text-slate-300 text-sm">
						Single image input. Connect into generators or feed your iterator
						later.
					</div>
				)}
				<FilePickerButton
					accept="image/*"
					label={data.asset ? "Replace image" : "Upload image"}
					onFiles={(files) =>
						void uploadFilesToNode(id, files, {
							kind: "image",
							multiple: false,
						})
					}
				/>
			</div>
		</NodeShell>
	);
}

function VideoUploadNode({ id, data, selected }: NodeProps<VideoNodeData>) {
	const { uploadFilesToNode, clearNodeAssets } = useStudioContext();

	return (
		<NodeShell
			data={data}
			icon="VID"
			output={{ id: "video", label: "Video", color: "#818cf8" }}
			selected={selected}
		>
			<div className="space-y-3">
				{data.asset ? (
					<div className="overflow-hidden rounded-3xl border border-white/10 bg-black/30">
						<div className="aspect-video">
							<AssetPreview asset={data.asset} />
						</div>
						<div className="flex items-center justify-between border-white/10 border-t px-3 py-3 text-slate-300 text-xs">
							<span className="truncate">{data.asset.fileName}</span>
							<ShellButton
								className="px-2 py-1 text-xs"
								onClick={() => clearNodeAssets(id)}
							>
								Clear
							</ShellButton>
						</div>
					</div>
				) : (
					<div className="rounded-3xl border border-white/14 border-dashed bg-black/20 px-4 py-8 text-slate-300 text-sm">
						Local video node for uploads, references, or future downstream
						processing.
					</div>
				)}
				<FilePickerButton
					accept="video/*"
					label={data.asset ? "Replace video" : "Upload video"}
					onFiles={(files) =>
						void uploadFilesToNode(id, files, {
							kind: "video",
							multiple: false,
						})
					}
				/>
			</div>
		</NodeShell>
	);
}

function ImageIteratorNode({
	id,
	data,
	selected,
}: NodeProps<ImageIteratorNodeData>) {
	const { uploadFilesToNode, clearNodeAssets } = useStudioContext();

	return (
		<NodeShell
			data={data}
			icon="SET"
			output={{ id: "images", label: "Images", color: "#38bdf8" }}
			selected={selected}
		>
			<div className="rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-slate-300 text-sm">
				{data.assets.length
					? `${data.assets.length} queued reference image${data.assets.length === 1 ? "" : "s"}`
					: "Upload multiple images. When this feeds a generator, the runner fans out one job per image."}
			</div>
			{data.assets.length ? <OutputGallery assets={data.assets} /> : null}
			<div className="flex items-center gap-2">
				<FilePickerButton
					accept="image/*"
					label={data.assets.length ? "Add more images" : "Upload batch"}
					multiple
					onFiles={(files) =>
						void uploadFilesToNode(id, files, { kind: "image", multiple: true })
					}
				/>
				{data.assets.length ? (
					<ShellButton onClick={() => clearNodeAssets(id)}>
						Clear batch
					</ShellButton>
				) : null}
			</div>
		</NodeShell>
	);
}

function ImageGeneratorNode({
	id,
	data,
	selected,
}: NodeProps<ImageGeneratorNodeData>) {
	const { updateNodeData, runNode } = useStudioContext();

	return (
		<NodeShell
			data={data}
			icon="GEN"
			inputs={[
				{ id: "prompt", label: "Prompt", color: "#f59e0b" },
				{ id: "image", label: "Single image", color: "#38bdf8" },
				{ id: "images", label: "Image batch", color: "#06b6d4" },
			]}
			model="Gemini 3 Pro Image (Nano Banana)"
			output={{ id: "images", label: "Images", color: "#22c55e" }}
			selected={selected}
		>
			<div className="grid grid-cols-2 gap-2">
				<label className="rounded-3xl border border-white/10 bg-black/25 px-3 py-3 text-slate-300 text-sm">
					<div className="mb-2 text-[11px] text-slate-500 uppercase tracking-[0.24em]">
						Aspect
					</div>
					<select
						className="w-full bg-transparent outline-none"
						onChange={(event) =>
							updateNodeData(id, (current) => ({
								...(current as ImageGeneratorNodeData),
								aspectRatio: event.target.value as ImageAspectRatio,
							}))
						}
						value={data.aspectRatio}
					>
						{IMAGE_ASPECT_RATIOS.map((ratio) => (
							<option className="bg-slate-950" key={ratio} value={ratio}>
								{ratio}
							</option>
						))}
					</select>
				</label>
				<div className="rounded-3xl border border-white/10 bg-black/25 px-3 py-3 text-slate-300 text-sm">
					<div className="mb-2 text-[11px] text-slate-500 uppercase tracking-[0.24em]">
						Model
					</div>
					<div>{data.model}</div>
				</div>
			</div>

			<ShellButton
				className="w-full justify-center"
				onClick={() => void runNode(id)}
			>
				Run image generation
			</ShellButton>

			{data.lastPrompt ? (
				<div className="rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-slate-300 text-sm">
					<div className="mb-2 text-[11px] text-slate-500 uppercase tracking-[0.24em]">
						Last prompt
					</div>
					<p>{data.lastPrompt}</p>
				</div>
			) : null}

			{data.responseText ? (
				<div className="rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-slate-300 text-sm">
					<div className="mb-2 text-[11px] text-slate-500 uppercase tracking-[0.24em]">
						Model note
					</div>
					<p>{data.responseText}</p>
				</div>
			) : null}

			<OutputGallery assets={data.outputAssets} />
		</NodeShell>
	);
}

function VideoGeneratorNode({
	id,
	data,
	selected,
}: NodeProps<VideoGeneratorNodeData>) {
	const { updateNodeData, runNode } = useStudioContext();

	return (
		<NodeShell
			data={data}
			icon="MOT"
			inputs={[
				{ id: "prompt", label: "Prompt", color: "#f59e0b" },
				{ id: "image", label: "Single image", color: "#38bdf8" },
				{ id: "images", label: "Image batch", color: "#06b6d4" },
			]}
			model="Veo 3.1"
			output={{ id: "videos", label: "Videos", color: "#a78bfa" }}
			selected={selected}
		>
			<div className="grid grid-cols-2 gap-2">
				<label className="rounded-3xl border border-white/10 bg-black/25 px-3 py-3 text-slate-300 text-sm">
					<div className="mb-2 text-[11px] text-slate-500 uppercase tracking-[0.24em]">
						Aspect
					</div>
					<select
						className="w-full bg-transparent outline-none"
						onChange={(event) =>
							updateNodeData(id, (current) => ({
								...(current as VideoGeneratorNodeData),
								aspectRatio: event.target.value as VideoAspectRatio,
							}))
						}
						value={data.aspectRatio}
					>
						{VIDEO_ASPECT_RATIOS.map((ratio) => (
							<option className="bg-slate-950" key={ratio} value={ratio}>
								{ratio}
							</option>
						))}
					</select>
				</label>
				<label className="rounded-3xl border border-white/10 bg-black/25 px-3 py-3 text-slate-300 text-sm">
					<div className="mb-2 text-[11px] text-slate-500 uppercase tracking-[0.24em]">
						Duration
					</div>
					<select
						className="w-full bg-transparent outline-none"
						onChange={(event) =>
							updateNodeData(id, (current) => ({
								...(current as VideoGeneratorNodeData),
								durationSeconds: Number(event.target.value) as VideoDuration,
							}))
						}
						value={data.durationSeconds}
					>
						{VIDEO_DURATIONS.map((duration) => (
							<option className="bg-slate-950" key={duration} value={duration}>
								{duration}s
							</option>
						))}
					</select>
				</label>
				<label className="rounded-3xl border border-white/10 bg-black/25 px-3 py-3 text-slate-300 text-sm">
					<div className="mb-2 text-[11px] text-slate-500 uppercase tracking-[0.24em]">
						Resolution
					</div>
					<select
						className="w-full bg-transparent outline-none"
						onChange={(event) =>
							updateNodeData(id, (current) => ({
								...(current as VideoGeneratorNodeData),
								resolution: event.target.value as VideoResolution,
							}))
						}
						value={data.resolution}
					>
						{VIDEO_RESOLUTIONS.map((resolution) => (
							<option
								className="bg-slate-950"
								key={resolution}
								value={resolution}
							>
								{resolution}
							</option>
						))}
					</select>
				</label>
				<label className="flex items-center justify-between rounded-3xl border border-white/10 bg-black/25 px-3 py-3 text-slate-300 text-sm">
					<span>Generate audio</span>
					<input
						checked={data.generateAudio}
						className="h-4 w-4 accent-white"
						onChange={(event) =>
							updateNodeData(id, (current) => ({
								...(current as VideoGeneratorNodeData),
								generateAudio: event.target.checked,
							}))
						}
						type="checkbox"
					/>
				</label>
			</div>

			<ShellButton
				className="w-full justify-center"
				onClick={() => void runNode(id)}
			>
				Run video generation
			</ShellButton>

			{data.lastPrompt ? (
				<div className="rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-slate-300 text-sm">
					<div className="mb-2 text-[11px] text-slate-500 uppercase tracking-[0.24em]">
						Last prompt
					</div>
					<p>{data.lastPrompt}</p>
				</div>
			) : null}

			<OutputGallery assets={data.outputAssets} />
		</NodeShell>
	);
}

const nodeTypes = {
	prompt: PromptNode,
	image: ImageUploadNode,
	video: VideoUploadNode,
	imageIterator: ImageIteratorNode,
	imageGenerator: ImageGeneratorNode,
	videoGenerator: VideoGeneratorNode,
};

async function parseApiResponse<T>(response: Response): Promise<T> {
	const payload = (await response.json().catch(() => null)) as
		| (T & { error?: string })
		| null;

	if (!response.ok) {
		throw new Error(payload?.error ?? "Request failed.");
	}

	if (!payload) {
		throw new Error("Empty API response.");
	}

	return payload;
}

function applyNodeUpdate(
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

function isEditableTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) {
		return false;
	}

	return Boolean(
		target.closest(
			'input, textarea, select, [contenteditable="true"], [role="textbox"]',
		),
	);
}

function formatDeletionActivity(nodeCount: number, edgeCount: number) {
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

export function WorkflowStudio() {
	const initialDocument = useMemo(() => loadDocument(), []);
	const [nodes, setNodes, onNodesChange] = useNodesState(initialDocument.nodes);
	const [edges, setEdges, onEdgesChange] = useEdgesState(initialDocument.edges);
	const [isReady, setIsReady] = useState(false);
	const [activity, setActivity] = useState(
		"Connect prompt and media nodes into the generators. Local graph state auto-saves in your browser.",
	);
	const flowRef = useRef<ReactFlowInstance | null>(null);
	const nodesRef = useRef(nodes);
	const edgesRef = useRef(edges);

	useEffect(() => {
		nodesRef.current = nodes;
	}, [nodes]);

	useEffect(() => {
		edgesRef.current = edges;
	}, [edges]);

	useEffect(() => {
		const loaded = loadDocument();
		setNodes(loaded.nodes);
		setEdges(loaded.edges);
		setIsReady(true);
	}, [setEdges, setNodes]);

	useEffect(() => {
		if (!isReady) {
			return;
		}

		const document: SavedWorkflowDocument = {
			version: 1,
			nodes,
			edges,
		};
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
	}, [edges, isReady, nodes]);

	const updateNodeData = useCallback(
		(nodeId: string, updater: (data: WorkflowNodeData) => WorkflowNodeData) => {
			setNodes((current) =>
				applyNodeUpdate(current as WorkflowNode[], nodeId, updater),
			);
		},
		[setNodes],
	);

	const clearNodeAssets = useCallback(
		(nodeId: string) => {
			updateNodeData(nodeId, (current) => {
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
		},
		[updateNodeData],
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
						const response = await fetch("/api/uploads", {
							method: "POST",
							body: formData,
						});
						const payload = await parseApiResponse<{ asset: WorkflowAsset }>(
							response,
						);
						return payload.asset;
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
		[updateNodeData],
	);

	const runNode = useCallback(
		async (nodeId: string) => {
			const snapshotNodes = nodesRef.current as WorkflowNode[];
			const snapshotEdges = edgesRef.current as WorkflowEdge[];
			const nodeMap = new Map(snapshotNodes.map((node) => [node.id, node]));
			const incomingByTarget = new Map<string, Edge[]>();
			const pending = new Map<string, Promise<RuntimeValue>>();
			const activeStack = new Set<string>();

			for (const edge of snapshotEdges) {
				const existing = incomingByTarget.get(edge.target) ?? [];
				existing.push(edge);
				incomingByTarget.set(edge.target, existing);
			}

			const getInputValues = async (targetId: string, handleId: string) => {
				const incomingEdges = (incomingByTarget.get(targetId) ?? []).filter(
					(edge) => edge.targetHandle === handleId,
				);
				return Promise.all(
					incomingEdges.map((edge) => evaluateNode(edge.source)),
				);
			};

			const coerceText = async (targetId: string) => {
				const values = await getInputValues(targetId, "prompt");
				const prompt = values.find((value) => value.type === "text");
				if (!prompt?.text.trim()) {
					throw new Error("Connect a prompt node with text.");
				}
				return prompt.text.trim();
			};

			const coerceImages = async (targetId: string) => {
				const [singleValues, batchValues] = await Promise.all([
					getInputValues(targetId, "image"),
					getInputValues(targetId, "images"),
				]);

				return [...singleValues, ...batchValues].flatMap((value) =>
					value.type === "image" ? value.assets : [],
				);
			};

			const evaluateNode = async (currentId: string): Promise<RuntimeValue> => {
				if (pending.has(currentId)) {
					const cached = pending.get(currentId);
					if (cached) {
						return cached;
					}
				}

				const promise: Promise<RuntimeValue> =
					(async (): Promise<RuntimeValue> => {
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
									return { type: "image", assets: [data.asset] };
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
									return { type: "image", assets: data.assets };
								}
								case "imageGenerator": {
									updateNodeData(currentId, (current) => ({
										...(current as ImageGeneratorNodeData),
										status: "running",
										error: null,
									}));
									setActivity(`Running ${data.label}...`);

									const prompt = await coerceText(currentId);
									const referenceImages = await coerceImages(currentId);
									const batches = referenceImages.length
										? referenceImages
										: [null];
									const generatedAssets: WorkflowAsset[] = [];
									let responseText: string | null = null;

									for (const referenceImage of batches) {
										const request: GenerateImageRequest = {
											prompt,
											referenceImages: referenceImage ? [referenceImage] : [],
											aspectRatio: data.aspectRatio,
										};
										const response = await fetch(
											"/api/workflow/generate-image",
											{
												method: "POST",
												headers: { "Content-Type": "application/json" },
												body: JSON.stringify(request),
											},
										);
										const payload =
											await parseApiResponse<GenerateImageResponse>(response);
										generatedAssets.push(...payload.assets);
										responseText = payload.responseText;
									}

									updateNodeData(currentId, (current) => ({
										...(current as ImageGeneratorNodeData),
										status: "success",
										error: null,
										lastPrompt: prompt,
										responseText,
										outputAssets: generatedAssets,
									}));

									return { type: "image", assets: generatedAssets };
								}
								case "videoGenerator": {
									updateNodeData(currentId, (current) => ({
										...(current as VideoGeneratorNodeData),
										status: "running",
										error: null,
									}));
									setActivity(`Running ${data.label}...`);

									const prompt = await coerceText(currentId);
									const sourceImages = await coerceImages(currentId);
									const batches = sourceImages.length ? sourceImages : [null];
									const generatedAssets: WorkflowAsset[] = [];

									for (const referenceImage of batches) {
										const request: GenerateVideoRequest = {
											prompt,
											referenceImage,
											aspectRatio: data.aspectRatio,
											durationSeconds: data.durationSeconds,
											generateAudio: data.generateAudio,
											resolution: data.resolution,
										};
										const response = await fetch(
											"/api/workflow/generate-video",
											{
												method: "POST",
												headers: { "Content-Type": "application/json" },
												body: JSON.stringify(request),
											},
										);
										const payload =
											await parseApiResponse<GenerateVideoResponse>(response);
										generatedAssets.push(...payload.assets);
									}

									updateNodeData(currentId, (current) => ({
										...(current as VideoGeneratorNodeData),
										status: "success",
										error: null,
										lastPrompt: prompt,
										outputAssets: generatedAssets,
									}));

									return { type: "video", assets: generatedAssets };
								}
							}
						} catch (error) {
							const message =
								error instanceof Error
									? error.message
									: "Node execution failed.";
							updateNodeData(currentId, (current) => {
								if (current.kind === "imageGenerator") {
									return {
										...(current as ImageGeneratorNodeData),
										status: "error",
										error: message,
									};
								}
								if (current.kind === "videoGenerator") {
									return {
										...(current as VideoGeneratorNodeData),
										status: "error",
										error: message,
									};
								}
								return {
									...current,
									status: "error",
									error: message,
								};
							});
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
		[updateNodeData],
	);

	const addNodeToCanvas = useCallback(
		(kind: WorkflowNodeKind) => {
			setNodes((current) => [
				...(current as WorkflowNode[]),
				createNode(kind, current.length),
			]);
			setActivity(`${formatNodeTitle(kind)} node added.`);
			requestAnimationFrame(() => flowRef.current?.fitView({ padding: 0.18 }));
		},
		[setNodes],
	);

	const runSelectedOrAll = useCallback(async () => {
		const currentNodes = nodesRef.current as WorkflowNode[];
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
	}, [runNode]);

	const deleteSelection = useCallback(() => {
		const currentNodes = nodesRef.current as WorkflowNode[];
		const currentEdges = edgesRef.current as WorkflowEdge[];
		const selectedNodeIds = new Set(
			currentNodes.filter((node) => node.selected).map((node) => node.id),
		);
		const selectedEdgeIds = new Set(
			currentEdges.filter((edge) => edge.selected).map((edge) => edge.id),
		);

		if (!selectedNodeIds.size && !selectedEdgeIds.size) {
			setActivity("Nothing selected to delete.");
			return;
		}

		const edgeIdsToRemove = new Set(
			currentEdges
				.filter(
					(edge) =>
						selectedEdgeIds.has(edge.id) ||
						selectedNodeIds.has(edge.source) ||
						selectedNodeIds.has(edge.target),
				)
				.map((edge) => edge.id),
		);

		setNodes((current) =>
			(current as WorkflowNode[]).filter(
				(node) => !selectedNodeIds.has(node.id),
			),
		);
		setEdges((current) =>
			(current as WorkflowEdge[]).filter(
				(edge) => !edgeIdsToRemove.has(edge.id),
			),
		);
		setActivity(
			formatDeletionActivity(selectedNodeIds.size, edgeIdsToRemove.size),
		);
	}, [setEdges, setNodes]);

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

	const resetGraph = useCallback(() => {
		const defaults = createDefaultDocument();
		setNodes(defaults.nodes);
		setEdges(defaults.edges);
		window.localStorage.removeItem(STORAGE_KEY);
		setActivity("Workflow reset to the starter graph.");
		requestAnimationFrame(() => flowRef.current?.fitView({ padding: 0.18 }));
	}, [setEdges, setNodes]);

	const onConnect = useCallback(
		(connection: Connection) => {
			setEdges((current) =>
				addEdge(
					{
						...connection,
						id: createNodeId(),
						type: "smoothstep",
						animated: false,
						style: { stroke: "rgba(226, 232, 240, 0.55)", strokeWidth: 2 },
					},
					current,
				),
			);
		},
		[setEdges],
	);

	const contextValue = useMemo<StudioContextValue>(
		() => ({
			updateNodeData,
			uploadFilesToNode,
			clearNodeAssets,
			runNode,
		}),
		[clearNodeAssets, runNode, updateNodeData, uploadFilesToNode],
	);

	return (
		<StudioContext.Provider value={contextValue}>
			<div className="min-h-screen bg-[radial-gradient(circle_at_top_left,#18324d,transparent_40%),radial-gradient(circle_at_top_right,#3f2335,transparent_30%),linear-gradient(180deg,#050816,#0b1022)] text-white">
				<div className="mx-auto flex min-h-screen max-w-[1800px] gap-6 px-5 py-5">
					<aside className="w-[320px] shrink-0 rounded-[32px] border border-white/10 bg-black/20 p-5 shadow-[0_30px_90px_rgba(0,0,0,0.35)] backdrop-blur">
						<div className="mb-8">
							<div className="mb-2 text-[11px] text-slate-400 uppercase tracking-[0.32em]">
								Faceless Factory
							</div>
							<h1 className="font-semibold text-3xl leading-tight">
								Node-based AI workflow MVP
							</h1>
							<p className="mt-3 text-slate-300 text-sm leading-6">
								Minimal Weavy-style canvas with local uploads, image iteration,
								Nano Banana Pro image generation, and Veo 3.1 video generation.
							</p>
						</div>

						<div className="mb-8 space-y-3">
							<div className="text-[11px] text-slate-400 uppercase tracking-[0.32em]">
								Add nodes
							</div>
							<div className="grid grid-cols-2 gap-2">
								{(
									[
										"prompt",
										"image",
										"video",
										"imageIterator",
										"imageGenerator",
										"videoGenerator",
									] as WorkflowNodeKind[]
								).map((kind) => (
									<ShellButton key={kind} onClick={() => addNodeToCanvas(kind)}>
										{formatNodeTitle(kind)}
									</ShellButton>
								))}
							</div>
						</div>

						<div className="mb-8 space-y-3">
							<div className="text-[11px] text-slate-400 uppercase tracking-[0.32em]">
								Run
							</div>
							<div className="grid grid-cols-1 gap-2">
								<ShellButton
									className="justify-center"
									onClick={() => void runSelectedOrAll()}
								>
									Run selected or all generators
								</ShellButton>
								<ShellButton className="justify-center" onClick={resetGraph}>
									Reset starter graph
								</ShellButton>
							</div>
						</div>

						<div className="space-y-3">
							<div className="text-[11px] text-slate-400 uppercase tracking-[0.32em]">
								Notes
							</div>
							<div className="rounded-[28px] border border-white/10 bg-black/20 p-4 text-slate-300 text-sm leading-6">
								<p>{activity}</p>
								<hr className="my-4 border-white/10" />
								<p>
									Image model locked to{" "}
									<span className="text-white">{NANO_BANANA_PRO_MODEL_ID}</span>
									.
								</p>
								<p>
									Video model locked to{" "}
									<span className="text-white">{VEO_31_MODEL_ID}</span>.
								</p>
								<p>
									Uploads and generated assets persist in local server storage.
								</p>
							</div>
						</div>
					</aside>

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
								onConnect={onConnect}
								onEdgesChange={onEdgesChange}
								onInit={(instance) => {
									flowRef.current = instance;
									requestAnimationFrame(() =>
										instance.fitView({ padding: 0.18 }),
									);
								}}
								onNodesChange={onNodesChange}
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
