import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  DeleteObjectCommand as S3DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Effect, Layer } from "effect";
import {
  type CreatePresignedDownloadUrlCommand,
  type CreatePresignedUploadUrlCommand,
  type DeleteObjectCommand,
  type DownloadObjectCommand,
  type ObjectExistsCommand,
  ObjectStorageError,
  type ObjectStorageOperation,
  ObjectStorageService,
  type UploadObjectCommand,
} from "~/core/application/object-storage-service";
import { env } from "~/env";

export const S3ObjectStorageLive = Layer.scoped(
  ObjectStorageService,
  Effect.gen(function* () {
    const client = yield* acquireS3Client;
    const bucket = env.OBJECT_STORAGE_BUCKET;

    return ObjectStorageService.of({
      createPresignedDownloadUrl: (command) =>
        createPresignedDownloadUrl(client, bucket, command),
      createPresignedUploadUrl: (command) =>
        createPresignedUploadUrl(client, bucket, command),
      delete: (command) => deleteObject(client, bucket, command),
      download: (command) => downloadObject(client, bucket, command),
      exists: (command) => objectExists(client, bucket, command),
      upload: (command) => uploadObject(client, bucket, command),
    });
  }),
);

const acquireS3Client = Effect.acquireRelease(
  Effect.sync(
    () =>
      new S3Client({
        credentials: {
          accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID,
          secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
        },
        endpoint: env.OBJECT_STORAGE_ENDPOINT,
        forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE !== "false",
        region: env.OBJECT_STORAGE_REGION,
      }),
  ),
  (client) => Effect.sync(() => client.destroy()),
);

function uploadObject(
  client: S3Client,
  bucket: string,
  command: UploadObjectCommand,
) {
  return Effect.gen(function* () {
    const key = yield* validateObjectKey(command.key, "upload");
    yield* Effect.tryPromise({
      try: async () => {
        const upload = new Upload({
          client,
          params: {
            Body: command.body,
            Bucket: bucket,
            ContentLength: command.contentLength,
            ContentType: command.contentType,
            Key: key,
          },
        });

        if (command.onProgress) {
          upload.on("httpUploadProgress", (progress) => {
            command.onProgress?.({
              key,
              loadedBytes: progress.loaded ?? 0,
              part: progress.part,
              totalBytes: progress.total,
            });
          });
        }

        await upload.done();
      },
      catch: (cause) =>
        new ObjectStorageError({
          cause,
          key,
          message: "Failed to upload object.",
          operation: "upload",
        }),
    });
  }).pipe(Effect.asVoid);
}

function downloadObject(
  client: S3Client,
  bucket: string,
  command: DownloadObjectCommand,
) {
  return Effect.gen(function* () {
    const key = yield* validateObjectKey(command.key, "download");
    const response = yield* Effect.tryPromise({
      try: () =>
        client.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
      catch: (cause) =>
        new ObjectStorageError({
          cause,
          key,
          message: "Failed to download object.",
          operation: "download",
        }),
    });
    const body = response.Body;
    if (!body) {
      return yield* Effect.fail(
        new ObjectStorageError({
          key,
          message: "Downloaded object response did not include a body.",
          operation: "download",
        }),
      );
    }

    const bytes = yield* Effect.tryPromise({
      try: () => body.transformToByteArray(),
      catch: (cause) =>
        new ObjectStorageError({
          cause,
          key,
          message: "Failed to read downloaded object body.",
          operation: "download",
        }),
    });

    return {
      body: bytes,
      contentLength: response.ContentLength,
      contentType: response.ContentType,
    };
  });
}

function deleteObject(
  client: S3Client,
  bucket: string,
  command: DeleteObjectCommand,
) {
  return Effect.gen(function* () {
    const key = yield* validateObjectKey(command.key, "delete");
    yield* Effect.tryPromise({
      try: () =>
        client.send(new S3DeleteObjectCommand({ Bucket: bucket, Key: key })),
      catch: (cause) =>
        new ObjectStorageError({
          cause,
          key,
          message: "Failed to delete object.",
          operation: "delete",
        }),
    });
  }).pipe(Effect.asVoid);
}

function objectExists(
  client: S3Client,
  bucket: string,
  command: ObjectExistsCommand,
) {
  return Effect.gen(function* () {
    const key = yield* validateObjectKey(command.key, "exists");
    return yield* Effect.tryPromise({
      try: () =>
        client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
      catch: (cause) =>
        new ObjectStorageError({
          cause,
          key,
          message: "Failed to check object existence.",
          operation: "exists",
        }),
    }).pipe(
      Effect.as(true),
      Effect.catchAll((error) => {
        const cause = error.cause;
        if (!cause || typeof cause !== "object") {
          return Effect.fail(error);
        }

        const hasNotFoundStatus =
          "$metadata" in cause &&
          typeof cause.$metadata === "object" &&
          cause.$metadata !== null &&
          "httpStatusCode" in cause.$metadata &&
          cause.$metadata.httpStatusCode === 404;
        const hasNotFoundName =
          "name" in cause &&
          (cause.name === "NoSuchKey" || cause.name === "NotFound");

        return hasNotFoundStatus || hasNotFoundName
          ? Effect.succeed(false)
          : Effect.fail(error);
      }),
    );
  });
}

function createPresignedUploadUrl(
  client: S3Client,
  bucket: string,
  command: CreatePresignedUploadUrlCommand,
) {
  return Effect.gen(function* () {
    const key = yield* validateObjectKey(command.key, "presign-upload");
    const expiresIn = command.expiresInSeconds ?? 3_600;
    const url = yield* Effect.tryPromise({
      try: () =>
        getSignedUrl(
          client,
          new PutObjectCommand({
            Bucket: bucket,
            ContentType: command.contentType,
            Key: key,
          }),
          { expiresIn },
        ),
      catch: (cause) =>
        new ObjectStorageError({
          cause,
          key,
          message: "Failed to create presigned upload URL.",
          operation: "presign-upload",
        }),
    });

    return {
      expiresAt: new Date(Date.now() + expiresIn * 1_000),
      key,
      url,
    };
  });
}

function createPresignedDownloadUrl(
  client: S3Client,
  bucket: string,
  command: CreatePresignedDownloadUrlCommand,
) {
  return Effect.gen(function* () {
    const key = yield* validateObjectKey(command.key, "presign-download");
    const expiresIn = command.expiresInSeconds ?? 3_600;
    const url = yield* Effect.tryPromise({
      try: () =>
        getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            ResponseContentDisposition: command.responseContentDisposition,
          }),
          { expiresIn },
        ),
      catch: (cause) =>
        new ObjectStorageError({
          cause,
          key,
          message: "Failed to create presigned download URL.",
          operation: "presign-download",
        }),
    });

    return {
      expiresAt: new Date(Date.now() + expiresIn * 1_000),
      key,
      url,
    };
  });
}

function validateObjectKey(key: string, operation: ObjectStorageOperation) {
  return Effect.try({
    try: () => {
      const trimmed = key.trim();
      const parts = trimmed.split("/");
      if (
        !trimmed ||
        trimmed.startsWith("/") ||
        parts.some((part) => !part || part === "." || part === "..")
      ) {
        throw new Error("Object key must be a non-empty relative key.");
      }
      return trimmed;
    },
    catch: (cause) =>
      new ObjectStorageError({
        cause,
        key,
        message: "Object key must be a non-empty relative key.",
        operation,
      }),
  });
}
