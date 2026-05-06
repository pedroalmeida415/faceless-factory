import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, desc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import {
  WorkflowAuthorizationError,
  WorkflowStorageError,
} from "~/features/workflow/errors";
import { assertWorkflowProjectAccess } from "~/features/workflow/server/projects";
import type {
  AssetKind,
  AssetSource,
  MediaAssetKind,
  StagedGeneratedMediaArtifact,
  WorkflowAsset,
} from "~/features/workflow/types";
import { assets } from "~/server/database/schema";
import { db } from "~/server/services/database";

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

type AssetRow = typeof assets.$inferSelect;

type AssetOwner = {
  ownerUserId: string;
  workflowId: string;
};

type SaveBufferAsAssetOptions = AssetOwner & {
  buffer: Buffer;
  kind: AssetKind;
  source: AssetSource;
  mimeType: string;
  fileName: string;
  model?: string | null;
};

type SaveExternalAssetOptions = AssetOwner & {
  kind: AssetKind;
  source: AssetSource;
  mimeType: string;
  fileName: string;
  model?: string | null;
  url: string;
};

type StageGeneratedBufferAsArtifactOptions = {
  buffer: Buffer;
  kind: MediaAssetKind;
  mimeType: string;
  fileName: string;
  model?: string | null;
};

type MaterializeProviderMediaInputOptions = {
  assetId: string;
  ownerUserId: string;
};

export type MaterializedProviderMediaInput =
  | {
      readonly assetId: string;
      readonly bytes: Buffer;
      readonly kind: "inline-bytes";
      readonly mimeType: string;
    }
  | {
      readonly assetId: string;
      readonly kind: "provider-uri";
      readonly mimeType: string;
      readonly uri: string;
    };

function toAssetWriteError(message: string, cause: unknown) {
  return cause instanceof WorkflowAuthorizationError
    ? cause
    : new WorkflowStorageError({
        message,
        cause,
      });
}

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

function buildAssetUrl(assetId: string) {
  return `/api/assets/${encodeURIComponent(assetId)}`;
}

function buildGeneratedStoragePaths(input: {
  assetId: string;
  fileName: string;
  kind: MediaAssetKind;
  mimeType: string;
}) {
  const extension = inferExtension(input.fileName, input.mimeType);
  const baseName = sanitizeBaseName(path.basename(input.fileName, extension));
  const dateFolder = new Date().toISOString().slice(0, 10);
  const storedFileName = `${input.assetId}-${baseName}${extension}`;

  return {
    fileName: `${baseName}${extension}`,
    promotedStoragePath: path.posix.join(
      "generated",
      input.kind,
      dateFolder,
      storedFileName,
    ),
    stagedStoragePath: path.posix.join(
      "staged-generated",
      input.kind,
      dateFolder,
      storedFileName,
    ),
  };
}

function toWorkflowAsset(row: AssetRow): WorkflowAsset {
  return {
    createdAt: row.createdAt.toISOString(),
    externalUri: row.externalUri,
    fileName: row.fileName,
    id: row.id,
    kind: row.kind,
    mimeType: row.mimeType,
    model: row.model,
    size: row.sizeBytes,
    source: row.source,
    storagePath: row.storageKey,
    url: buildAssetUrl(row.id),
  } satisfies WorkflowAsset;
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

async function insertAssetRecord(params: {
  externalUri: string | null;
  fileName: string;
  id: string;
  kind: AssetKind;
  mimeType: string;
  model: string | null;
  ownerUserId: string;
  workflowId: string;
  sizeBytes: number;
  source: AssetSource;
  storageKey: string | null;
  storageProvider: string;
}) {
  await assertWorkflowProjectAccess({
    ownerUserId: params.ownerUserId,
    projectId: params.workflowId,
  });

  const [asset] = await db
    .insert(assets)
    .values({
      createdAt: new Date(),
      externalUri: params.externalUri,
      fileName: params.fileName,
      id: params.id,
      kind: params.kind,
      mimeType: params.mimeType,
      model: params.model,
      ownerUserId: params.ownerUserId,
      workflowId: params.workflowId,
      sizeBytes: params.sizeBytes,
      source: params.source,
      storageKey: params.storageKey,
      storageProvider: params.storageProvider,
    })
    .returning();

  if (!asset) {
    throw new WorkflowStorageError({
      message: "Failed to persist asset metadata.",
    });
  }

  return toWorkflowAsset(asset);
}

function listWorkflowAssetsEffect(params: {
  ownerUserId: string;
  workflowId: string;
}) {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        assertWorkflowProjectAccess({
          ownerUserId: params.ownerUserId,
          projectId: params.workflowId,
        }),
      catch: (cause) =>
        toAssetWriteError("Failed to load project assets.", cause),
    });

    const projectAssets = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(assets)
          .where(
            and(
              eq(assets.ownerUserId, params.ownerUserId),
              eq(assets.workflowId, params.workflowId),
              isNull(assets.deletedAt),
            ),
          )
          .orderBy(desc(assets.createdAt)),
      catch: (cause) =>
        new WorkflowStorageError({
          message: "Failed to load project assets.",
          cause,
        }),
    });

    return projectAssets.map(toWorkflowAsset);
  });
}

function saveBufferAsAssetEffect({
  buffer,
  kind,
  source,
  mimeType,
  fileName,
  model = null,
  ownerUserId,
  workflowId,
}: SaveBufferAsAssetOptions) {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        assertWorkflowProjectAccess({
          ownerUserId,
          projectId: workflowId,
        }),
      catch: (cause) =>
        toAssetWriteError("Failed to persist asset metadata.", cause),
    });

    const extension = inferExtension(fileName, mimeType);
    const baseName = sanitizeBaseName(path.basename(fileName, extension));
    const dateFolder = new Date().toISOString().slice(0, 10);
    const storageKey = path.posix.join(
      source,
      kind,
      dateFolder,
      `${randomUUID()}-${baseName}${extension}`,
    );
    const absolutePath = yield* Effect.try({
      try: () => resolveAssetAbsolutePath(storageKey),
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

    return yield* Effect.tryPromise({
      try: () =>
        insertAssetRecord({
          externalUri: null,
          fileName: `${baseName}${extension}`,
          id: randomUUID(),
          kind,
          mimeType,
          model,
          ownerUserId,
          workflowId,
          sizeBytes: buffer.byteLength,
          source,
          storageKey,
          storageProvider: "local",
        }),
      catch: (cause) =>
        toAssetWriteError("Failed to persist asset metadata.", cause),
    });
  });
}

function stageGeneratedBufferAsArtifactEffect({
  buffer,
  fileName,
  kind,
  mimeType,
  model = null,
}: StageGeneratedBufferAsArtifactOptions) {
  return Effect.gen(function* () {
    const assetId = randomUUID();
    const paths = buildGeneratedStoragePaths({
      assetId,
      fileName,
      kind,
      mimeType,
    });
    const absolutePath = yield* Effect.try({
      try: () => resolveAssetAbsolutePath(paths.stagedStoragePath),
      catch: (cause) =>
        new WorkflowStorageError({
          message: "Invalid staged generated artifact path.",
          cause,
        }),
    });

    yield* Effect.tryPromise({
      try: () => mkdir(path.dirname(absolutePath), { recursive: true }),
      catch: (cause) =>
        new WorkflowStorageError({
          message: "Failed to prepare staged generated artifact directory.",
          cause,
        }),
    });
    yield* Effect.tryPromise({
      try: () => writeFile(absolutePath, buffer),
      catch: (cause) =>
        new WorkflowStorageError({
          message: "Failed to write staged generated artifact.",
          cause,
        }),
    });

    return {
      externalUri: null,
      fileName: paths.fileName,
      id: assetId,
      kind,
      mimeType,
      model,
      promotedStoragePath: paths.promotedStoragePath,
      size: buffer.byteLength,
      stagedStoragePath: paths.stagedStoragePath,
      storageProvider: "local-staged",
      url: buildAssetUrl(assetId),
    } satisfies StagedGeneratedMediaArtifact;
  });
}

export async function promoteStagedGeneratedArtifact(input: {
  promotedStoragePath: string;
  stagedStoragePath: string;
}) {
  const stagedPath = resolveAssetAbsolutePath(input.stagedStoragePath);
  const promotedPath = resolveAssetAbsolutePath(input.promotedStoragePath);
  await mkdir(path.dirname(promotedPath), { recursive: true });
  await rename(stagedPath, promotedPath).catch(async (cause: unknown) => {
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      await access(promotedPath);
      return;
    }
    throw cause;
  });
}

function saveExternalAssetEffect({
  fileName,
  kind,
  mimeType,
  model = null,
  ownerUserId,
  workflowId,
  source,
  url,
}: SaveExternalAssetOptions) {
  return Effect.tryPromise({
    try: () =>
      insertAssetRecord({
        externalUri: url,
        fileName,
        id: randomUUID(),
        kind,
        mimeType,
        model,
        ownerUserId,
        workflowId,
        sizeBytes: 0,
        source,
        storageKey: null,
        storageProvider: "external",
      }),
    catch: (cause) =>
      toAssetWriteError("Failed to persist external asset metadata.", cause),
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

function readAssetByIdEffect(params: { assetId: string; userId: string }) {
  return Effect.gen(function* () {
    const [asset] = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(assets)
          .where(
            and(
              isNull(assets.deletedAt),
              eq(assets.id, params.assetId),
              eq(assets.ownerUserId, params.userId),
            ),
          )
          .limit(1),
      catch: (cause) =>
        new WorkflowStorageError({
          message: "Failed to load asset metadata.",
          cause,
        }),
    });

    if (!asset) {
      return yield* Effect.fail(
        new WorkflowAuthorizationError({
          message: `Asset ${params.assetId} was not found.`,
        }),
      );
    }

    if (asset.externalUri) {
      return {
        data: null,
        externalUri: asset.externalUri,
        mimeType: asset.mimeType,
      };
    }

    const storageKey = asset.storageKey;
    if (!storageKey) {
      return yield* Effect.fail(
        new WorkflowStorageError({
          message: "Asset is missing a storage key.",
        }),
      );
    }

    const absolutePath = yield* Effect.try({
      try: () => resolveAssetAbsolutePath(storageKey),
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
      externalUri: null,
      mimeType: asset.mimeType || guessMimeType(storageKey),
    };
  });
}

function materializeProviderMediaInputEffect({
  assetId,
  ownerUserId,
}: MaterializeProviderMediaInputOptions) {
  return Effect.gen(function* () {
    const asset = yield* readAssetByIdEffect({ assetId, userId: ownerUserId });

    if (asset.data) {
      return {
        assetId,
        bytes: asset.data,
        kind: "inline-bytes",
        mimeType: asset.mimeType,
      } satisfies MaterializedProviderMediaInput;
    }

    if (asset.externalUri) {
      return {
        assetId,
        kind: "provider-uri",
        mimeType: asset.mimeType,
        uri: asset.externalUri,
      } satisfies MaterializedProviderMediaInput;
    }

    return yield* Effect.fail(
      new WorkflowStorageError({
        message: `Asset ${assetId} could not be materialized for provider input.`,
      }),
    );
  });
}

export class StorageService extends Context.Tag("StorageService")<
  StorageService,
  {
    readonly readAssetById: (params: {
      assetId: string;
      userId: string;
    }) => Effect.Effect<
      { data: Buffer | null; externalUri: string | null; mimeType: string },
      WorkflowAuthorizationError | WorkflowStorageError
    >;
    readonly readStoredAsset: (
      asset: Pick<WorkflowAsset, "storagePath">,
    ) => Effect.Effect<Buffer, WorkflowStorageError>;
    readonly listWorkflowAssets: (params: {
      ownerUserId: string;
      workflowId: string;
    }) => Effect.Effect<
      WorkflowAsset[],
      WorkflowAuthorizationError | WorkflowStorageError
    >;
    readonly materializeProviderMediaInput: (
      options: MaterializeProviderMediaInputOptions,
    ) => Effect.Effect<
      MaterializedProviderMediaInput,
      WorkflowAuthorizationError | WorkflowStorageError
    >;
    readonly saveBufferAsAsset: (
      options: SaveBufferAsAssetOptions,
    ) => Effect.Effect<
      WorkflowAsset,
      WorkflowAuthorizationError | WorkflowStorageError
    >;
    readonly stageGeneratedBufferAsArtifact: (
      options: StageGeneratedBufferAsArtifactOptions,
    ) => Effect.Effect<StagedGeneratedMediaArtifact, WorkflowStorageError>;
    readonly saveExternalAsset: (
      options: SaveExternalAssetOptions,
    ) => Effect.Effect<
      WorkflowAsset,
      WorkflowAuthorizationError | WorkflowStorageError
    >;
    readonly saveFormFileAsAsset: (options: {
      file: File;
      kind: MediaAssetKind;
      ownerUserId: string;
      workflowId: string;
      source: AssetSource;
      model?: string | null;
    }) => Effect.Effect<
      WorkflowAsset,
      WorkflowAuthorizationError | WorkflowStorageError
    >;
  }
>() {
  static readonly Live = Layer.succeed(this, {
    listWorkflowAssets: listWorkflowAssetsEffect,
    materializeProviderMediaInput: materializeProviderMediaInputEffect,
    readAssetById: readAssetByIdEffect,
    readStoredAsset: readStoredAssetEffect,
    saveBufferAsAsset: saveBufferAsAssetEffect,
    saveExternalAsset: saveExternalAssetEffect,
    stageGeneratedBufferAsArtifact: stageGeneratedBufferAsArtifactEffect,
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
          fileName: options.file.name,
          kind: options.kind,
          mimeType: options.file.type || guessMimeType(options.file.name),
          model: options.model,
          ownerUserId: options.ownerUserId,
          workflowId: options.workflowId,
          source: options.source,
        });
      }),
  });
}
