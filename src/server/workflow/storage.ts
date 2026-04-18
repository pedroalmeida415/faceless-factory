import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Context, Effect, Layer } from "effect";

import { WorkflowStorageError } from "~/lib/workflow/errors";
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

function guessMimeType(fileName: string) {
	const ext = path.extname(fileName).toLowerCase();
	return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}

function buildAssetUrl(storagePath: string) {
	return `/api/assets/${storagePath
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/")}`;
}

function resolveAssetAbsolutePath(storagePath: string) {
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

function saveBufferAsAssetEffect({
	buffer,
	kind,
	source,
	mimeType,
	fileName,
	model = null,
}: SaveBufferAsAssetOptions) {
	return Effect.gen(function* () {
		const extension = inferExtension(fileName, mimeType);
		const baseName = sanitizeBaseName(path.basename(fileName, extension));
		const dateFolder = new Date().toISOString().slice(0, 10);
		const relativePath = path.posix.join(
			source,
			kind,
			dateFolder,
			`${randomUUID()}-${baseName}${extension}`,
		);
		const absolutePath = yield* Effect.try({
			try: () => resolveAssetAbsolutePath(relativePath),
			catch: (cause) =>
				new WorkflowStorageError({
					message: "Invalid asset path.",
					cause,
				}),
		});

		yield* Effect.tryPromise({
			try: () => mkdir(path.dirname(absolutePath), { recursive: true }),
			catch: (cause) =>
				new WorkflowStorageError({
					message: "Failed to prepare asset directory.",
					cause,
				}),
		});
		yield* Effect.tryPromise({
			try: () => writeFile(absolutePath, buffer),
			catch: (cause) =>
				new WorkflowStorageError({
					message: "Failed to write asset to local storage.",
					cause,
				}),
		});

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
		} satisfies WorkflowAsset;
	});
}

function readStoredAssetEffect(asset: Pick<WorkflowAsset, "storagePath">) {
	return Effect.gen(function* () {
		const storagePath = asset.storagePath;
		if (!storagePath) {
			return yield* Effect.fail(
				new WorkflowStorageError({
					message: "Asset is not stored locally.",
				}),
			);
		}

		const absolutePath = yield* Effect.try({
			try: () => resolveAssetAbsolutePath(storagePath),
			catch: (cause) =>
				new WorkflowStorageError({
					message: "Invalid asset path.",
					cause,
				}),
		});

		return yield* Effect.tryPromise({
			try: () => readFile(absolutePath),
			catch: (cause) =>
				new WorkflowStorageError({
					message: "Unable to read stored asset.",
					cause,
				}),
		});
	});
}

function readAssetByPathEffect(storagePath: string) {
	return Effect.gen(function* () {
		const absolutePath = yield* Effect.try({
			try: () => resolveAssetAbsolutePath(storagePath),
			catch: (cause) =>
				new WorkflowStorageError({
					message: "Invalid asset path.",
					cause,
				}),
		});

		const data = yield* Effect.tryPromise({
			try: () => readFile(absolutePath),
			catch: (cause) =>
				new WorkflowStorageError({
					message: "Unable to read asset.",
					cause,
				}),
		});

		return {
			data,
			mimeType: guessMimeType(storagePath),
		};
	});
}

export class WorkflowStorage extends Context.Tag("WorkflowStorage")<
	WorkflowStorage,
	{
		readonly saveBufferAsAsset: (
			options: SaveBufferAsAssetOptions,
		) => Effect.Effect<WorkflowAsset, WorkflowStorageError>;
		readonly saveFormFileAsAsset: (options: {
			file: File;
			kind: AssetKind;
			source: AssetSource;
			model?: string | null;
		}) => Effect.Effect<WorkflowAsset, WorkflowStorageError>;
		readonly readStoredAsset: (
			asset: Pick<WorkflowAsset, "storagePath">,
		) => Effect.Effect<Buffer, WorkflowStorageError>;
		readonly readAssetByPath: (
			storagePath: string,
		) => Effect.Effect<
			{ data: Buffer; mimeType: string },
			WorkflowStorageError
		>;
	}
>() {
	static readonly functions = Effect.serviceFunctions(this);

	static readonly Live = Layer.succeed(this, {
		readAssetByPath: readAssetByPathEffect,
		readStoredAsset: readStoredAssetEffect,
		saveBufferAsAsset: saveBufferAsAssetEffect,
		saveFormFileAsAsset: (options) =>
			Effect.gen(function* () {
				const buffer = yield* Effect.tryPromise({
					try: async () => Buffer.from(await options.file.arrayBuffer()),
					catch: (cause) =>
						new WorkflowStorageError({
							message: "Failed to read uploaded file.",
							cause,
						}),
				});

				return yield* saveBufferAsAssetEffect({
					buffer,
					kind: options.kind,
					source: options.source,
					mimeType: options.file.type || guessMimeType(options.file.name),
					fileName: options.file.name,
					model: options.model,
				});
			}),
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
