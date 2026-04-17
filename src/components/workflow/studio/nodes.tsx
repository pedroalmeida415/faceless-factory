"use client";

import { useEffect } from "react";
import { type NodeProps, useUpdateNodeInternals } from "reactflow";

import {
	IMAGE_ASPECT_RATIOS,
	type ImageAspectRatio,
	type ImageGeneratorNodeData,
	type ImageIteratorNodeData,
	type ImageNodeData,
	type PromptNodeData,
	VIDEO_ASPECT_RATIOS,
	VIDEO_DURATIONS,
	VIDEO_RESOLUTIONS,
	type VideoAspectRatio,
	type VideoDuration,
	type VideoGeneratorNodeData,
	type VideoNodeData,
	type VideoResolution,
} from "~/lib/workflow/types";
import { useStudioContext } from "./context";
import { PROMPT_INPUT_HANDLE_ID } from "./graph";
import {
	AssetPreview,
	FilePickerButton,
	NodeShell,
	OutputGallery,
	ShellButton,
} from "./shared";

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
	const updateNodeInternals = useUpdateNodeInternals();
	const {
		getGeneratorImageInputs,
		getGeneratorIterationInfo,
		updateNodeData,
		runNode,
	} = useStudioContext();
	const imageInputs = getGeneratorImageInputs(id);
	const iterationInfo = getGeneratorIterationInfo(id);

	useEffect(() => {
		if (!imageInputs.length) {
			return;
		}

		updateNodeInternals(id);
	}, [id, imageInputs.length, updateNodeInternals]);

	return (
		<NodeShell
			data={data}
			icon="GEN"
			inputs={[
				{ id: PROMPT_INPUT_HANDLE_ID, label: "Prompt", color: "#f59e0b" },
				...imageInputs,
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

			{iterationInfo.hasIterator ? (
				<div className="rounded-2xl border border-sky-300/18 bg-sky-400/8 px-3 py-3 text-sky-100 text-sm">
					{iterationInfo.mismatchedIterators
						? "Connected iterators disagree on batch size."
						: `Will run ${iterationInfo.iterations} iteration${iterationInfo.iterations === 1 ? "" : "s"}. Other connected images are reused in every pass.`}
				</div>
			) : null}

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
	const updateNodeInternals = useUpdateNodeInternals();
	const {
		getGeneratorImageInputs,
		getGeneratorIterationInfo,
		updateNodeData,
		runNode,
	} = useStudioContext();
	const imageInputs = getGeneratorImageInputs(id);
	const iterationInfo = getGeneratorIterationInfo(id);

	useEffect(() => {
		if (!imageInputs.length) {
			return;
		}

		updateNodeInternals(id);
	}, [id, imageInputs.length, updateNodeInternals]);

	return (
		<NodeShell
			data={data}
			icon="MOT"
			inputs={[
				{ id: PROMPT_INPUT_HANDLE_ID, label: "Prompt", color: "#f59e0b" },
				...imageInputs,
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

			{iterationInfo.hasIterator ? (
				<div className="rounded-2xl border border-sky-300/18 bg-sky-400/8 px-3 py-3 text-sky-100 text-sm">
					{iterationInfo.mismatchedIterators
						? "Connected iterators disagree on batch size."
						: `Will run ${iterationInfo.iterations} iteration${iterationInfo.iterations === 1 ? "" : "s"}. Other connected images are reused in every pass.`}
				</div>
			) : null}

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

export const nodeTypes = {
	prompt: PromptNode,
	image: ImageUploadNode,
	video: VideoUploadNode,
	imageIterator: ImageIteratorNode,
	imageGenerator: ImageGeneratorNode,
	videoGenerator: VideoGeneratorNode,
};
