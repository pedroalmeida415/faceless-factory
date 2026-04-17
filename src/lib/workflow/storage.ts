import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
	AssetKind,
	AssetSource,
	WorkflowAsset,
} from "~/lib/workflow/types";

const STORAGE_ROOT = path.join(process.cwd(), ".data", "workflow-assets");

const MIME_TO_EXTENSION: Record<string, string> = {
	"image/gif": ".gif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"video/webm": ".webm",
};

const EXTENSION_TO_MIME: Record<string, string> = {
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".mov": "video/quicktime",
	".mp4": "video/mp4",
	".png": "image/png",
	".webm": "video/webm",
	".webp": "image/webp",
};

type SaveBufferAsAssetOptions = {
	buffer: Buffer;
	kind: AssetKind;
	source: AssetSource;
	mimeType: string;
	fileName: string;
	model?: string | null;
};

type CreateExternalAssetOptions = {
	kind: AssetKind;
	source: AssetSource;
	mimeType: string;
	fileName: string;
	url: string;
	model?: string | null;
};

function sanitizeBaseName(input: string) {
	return (
		input
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "asset"
	);
}

function inferExtension(fileName: string, mimeType: string) {
	const ext = path.extname(fileName).toLowerCase();
	if (ext) {
		return ext;
	}
	return MIME_TO_EXTENSION[mimeType] ?? "";
}

export function guessMimeType(fileName: string) {
	const ext = path.extname(fileName).toLowerCase();
	return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}

export function buildAssetUrl(storagePath: string) {
	return `/api/assets/${storagePath
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/")}`;
}

export function resolveAssetAbsolutePath(storagePath: string) {
	const normalized = path.posix
		.normalize(storagePath)
		.replace(/^(\.\.\/)+/, "");
	const absolutePath = path.join(STORAGE_ROOT, normalized);
	const relativePath = path.relative(STORAGE_ROOT, absolutePath);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		throw new Error("Invalid asset path.");
	}
	return absolutePath;
}

export async function saveBufferAsAsset({
	buffer,
	kind,
	source,
	mimeType,
	fileName,
	model = null,
}: SaveBufferAsAssetOptions): Promise<WorkflowAsset> {
	const extension = inferExtension(fileName, mimeType);
	const baseName = sanitizeBaseName(path.basename(fileName, extension));
	const dateFolder = new Date().toISOString().slice(0, 10);
	const relativePath = path.posix.join(
		source,
		kind,
		dateFolder,
		`${randomUUID()}-${baseName}${extension}`,
	);
	const absolutePath = resolveAssetAbsolutePath(relativePath);

	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, buffer);

	return {
		id: randomUUID(),
		kind,
		source,
		fileName: `${baseName}${extension}`,
		mimeType,
		size: buffer.byteLength,
		createdAt: new Date().toISOString(),
		url: buildAssetUrl(relativePath),
		storagePath: relativePath,
		externalUri: null,
		model,
	};
}

export async function saveFormFileAsAsset(options: {
	file: File;
	kind: AssetKind;
	source: AssetSource;
	model?: string | null;
}) {
	const { file, kind, source, model = null } = options;
	const buffer = Buffer.from(await file.arrayBuffer());
	return saveBufferAsAsset({
		buffer,
		kind,
		source,
		mimeType: file.type || guessMimeType(file.name),
		fileName: file.name,
		model,
	});
}

export function createExternalAsset({
	kind,
	source,
	mimeType,
	fileName,
	url,
	model = null,
}: CreateExternalAssetOptions): WorkflowAsset {
	return {
		id: randomUUID(),
		kind,
		source,
		fileName,
		mimeType,
		size: 0,
		createdAt: new Date().toISOString(),
		url,
		storagePath: null,
		externalUri: url,
		model,
	};
}

export async function readStoredAsset(
	asset: Pick<WorkflowAsset, "storagePath">,
) {
	if (!asset.storagePath) {
		throw new Error("Asset is not stored locally.");
	}
	const absolutePath = resolveAssetAbsolutePath(asset.storagePath);
	return readFile(absolutePath);
}

export async function statStoredAsset(
	asset: Pick<WorkflowAsset, "storagePath">,
) {
	if (!asset.storagePath) {
		throw new Error("Asset is not stored locally.");
	}
	const absolutePath = resolveAssetAbsolutePath(asset.storagePath);
	return stat(absolutePath);
}
