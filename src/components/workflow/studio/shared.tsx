"use client";

import Image from "next/image";
import {
	type ButtonHTMLAttributes,
	type PropsWithChildren,
	useId,
} from "react";
import { Handle, Position } from "reactflow";

import type {
	WorkflowAsset,
	WorkflowNodeData,
	WorkflowNodeStatus,
} from "~/lib/workflow/types";
import { formatNodeTitle, type HandleDefinition } from "./graph";

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

export function ShellButton(
	props: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>,
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

export function AssetPreview({
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

export function OutputGallery({ assets }: { assets: WorkflowAsset[] }) {
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

export function FilePickerButton({
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

export function NodeShell({
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
	const inputLegend = inputs.filter(
		(input, index, list) =>
			list.findIndex(
				(candidate) =>
					candidate.label === input.label && candidate.color === input.color,
			) === index,
	);

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

			{inputLegend.length ? (
				<div className="mb-4 space-y-2">
					{inputLegend.map((input) => (
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
