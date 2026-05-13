import { Context, Data, type Effect } from "effect";

export type ObjectStorageOperation =
  | "delete"
  | "download"
  | "exists"
  | "presign-download"
  | "presign-upload"
  | "upload";

export type UploadObjectCommand = {
  readonly body: Uint8Array;
  readonly contentLength?: number;
  readonly contentType?: string;
  readonly key: string;
  readonly onProgress?: (progress: UploadObjectProgress) => void;
};

export type UploadObjectProgress = {
  readonly key: string;
  readonly loadedBytes: number;
  readonly part?: number;
  readonly totalBytes?: number;
};

export type DownloadObjectCommand = {
  readonly key: string;
};

export type DownloadObjectResult = {
  readonly body: Uint8Array;
  readonly contentLength?: number;
  readonly contentType?: string;
};

export type DeleteObjectCommand = {
  readonly key: string;
};

export type ObjectExistsCommand = {
  readonly key: string;
};

export type CreatePresignedUploadUrlCommand = {
  readonly contentType?: string;
  readonly expiresInSeconds?: number;
  readonly key: string;
};

export type CreatePresignedDownloadUrlCommand = {
  readonly expiresInSeconds?: number;
  readonly key: string;
  readonly responseContentDisposition?: string;
};

export type PresignedObjectUrl = {
  readonly expiresAt: Date;
  readonly key: string;
  readonly url: string;
};

export class ObjectStorageError extends Data.TaggedError("ObjectStorageError")<{
  readonly cause?: unknown;
  readonly key?: string;
  readonly message: string;
  readonly operation: ObjectStorageOperation;
}> {}

export type ObjectStorageServiceApi = {
  readonly createPresignedDownloadUrl: (
    command: CreatePresignedDownloadUrlCommand,
  ) => Effect.Effect<PresignedObjectUrl, ObjectStorageError>;
  readonly createPresignedUploadUrl: (
    command: CreatePresignedUploadUrlCommand,
  ) => Effect.Effect<PresignedObjectUrl, ObjectStorageError>;
  readonly delete: (command: DeleteObjectCommand) => Effect.Effect<void, ObjectStorageError>;
  readonly download: (command: DownloadObjectCommand) => Effect.Effect<DownloadObjectResult, ObjectStorageError>;
  readonly exists: (command: ObjectExistsCommand) => Effect.Effect<boolean, ObjectStorageError>;
  readonly upload: (command: UploadObjectCommand) => Effect.Effect<void, ObjectStorageError>;
};

export class ObjectStorageService extends Context.Tag("ObjectStorageService")<
  ObjectStorageService,
  ObjectStorageServiceApi
>() {}
