import { randomUUID } from "node:crypto";
import {
  createPartFromBase64,
  createPartFromUri,
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  VideoGenerationReferenceType,
} from "@google/genai";
import { Context, Effect, Layer } from "effect";

import { env } from "~/env";
import {
  type WorkflowAuthorizationError,
  WorkflowConfigError,
  WorkflowGenerationError,
  WorkflowStorageError,
  WorkflowValidationError,
} from "~/features/workflow/errors";
import type {
  GenerateImageRequest,
  GenerateImageResponse,
  GenerateLlmRequest,
  GenerateLlmResponse,
  GenerateLlmUsage,
  GenerateVideoRequest,
  GenerateVideoResponse,
  LlmThinkingLevel,
  StagedGeneratedMediaArtifact,
  WorkflowAsset,
} from "~/features/workflow/types";
import { StorageService } from "~/server/services/storage";

type GenerateContentResponse = Awaited<
  ReturnType<GoogleGenAI["models"]["generateContent"]>
>;

type GenerateVideosOperation = Awaited<
  ReturnType<GoogleGenAI["models"]["generateVideos"]>
>;

type VertexCallLogContext = {
  idempotencyKey: string | null;
  location: string;
  model: string;
  operation: string;
  params?: Record<string, boolean | number | string | null>;
};

function getErrorName(cause: unknown) {
  return cause instanceof Error ? cause.name : typeof cause;
}

function getErrorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function getProviderError(cause: unknown) {
  const message = getErrorMessage(cause);
  try {
    const parsed = JSON.parse(message) as {
      error?: { code?: number; message?: string; status?: string };
    };
    return parsed.error
      ? {
          providerCode: parsed.error.code ?? null,
          providerMessage: parsed.error.message ?? null,
          providerStatus: parsed.error.status ?? null,
        }
      : null;
  } catch {
    return null;
  }
}

function logVertexCallStart(context: VertexCallLogContext) {
  console.info("Vertex AI call started", context);
}

function logVertexCallSuccess(
  context: VertexCallLogContext,
  startedAt: number,
  result?: Record<string, boolean | number | string | null>,
) {
  console.info("Vertex AI call succeeded", {
    ...context,
    durationMs: Date.now() - startedAt,
    result,
  });
}

function logVertexCallFailure(
  context: VertexCallLogContext,
  startedAt: number,
  cause: unknown,
) {
  console.error("Vertex AI call failed", {
    ...context,
    durationMs: Date.now() - startedAt,
    error: {
      message: getErrorMessage(cause),
      name: getErrorName(cause),
      ...getProviderError(cause),
    },
  });
}

function runVertexSdkCall<T>(params: {
  call: () => Promise<T>;
  errorMessage: string;
  logContext: VertexCallLogContext;
  result?: (value: T) => Record<string, boolean | number | string | null>;
}) {
  return Effect.tryPromise({
    try: async () => {
      const startedAt = Date.now();
      logVertexCallStart(params.logContext);
      try {
        const result = await params.call();
        logVertexCallSuccess(
          params.logContext,
          startedAt,
          params.result?.(result),
        );
        return result;
      } catch (cause) {
        logVertexCallFailure(params.logContext, startedAt, cause);
        throw cause;
      }
    },
    catch: (cause) =>
      new WorkflowGenerationError({
        message: params.errorMessage,
        cause,
      }),
  });
}

function toThinkingLevel(thinkingLevel: LlmThinkingLevel) {
  switch (thinkingLevel) {
    case "MINIMAL":
      return ThinkingLevel.MINIMAL;
    case "LOW":
      return ThinkingLevel.LOW;
    case "MEDIUM":
      return ThinkingLevel.MEDIUM;
    case "HIGH":
      return ThinkingLevel.HIGH;
  }
}

function pickImageParts(response: GenerateContentResponse) {
  return (
    response.candidates
      ?.flatMap((candidate) => candidate.content?.parts ?? [])
      .filter((part) => Boolean(part.inlineData?.data)) ?? []
  );
}

function pollVideosOperation(
  client: GoogleGenAI,
  operation: GenerateVideosOperation,
  timeoutAt: number,
  logContext: VertexCallLogContext,
): Effect.Effect<GenerateVideosOperation, WorkflowGenerationError> {
  if (operation.done) {
    return Effect.succeed(operation);
  }

  if (Date.now() > timeoutAt) {
    return Effect.fail(
      new WorkflowGenerationError({
        message: "Veo generation timed out after 6 minutes.",
      }),
    );
  }

  return Effect.gen(function* () {
    yield* Effect.sleep(10_000);
    const nextOperation = yield* Effect.tryPromise({
      try: async () => {
        const startedAt = Date.now();
        const context = {
          ...logContext,
          operation: "videos.getOperation",
        } satisfies VertexCallLogContext;
        logVertexCallStart(context);
        try {
          const response = await client.operations.getVideosOperation({
            operation,
          });
          logVertexCallSuccess(context, startedAt, {
            done: response.done ?? false,
          });
          return response;
        } catch (cause) {
          logVertexCallFailure(context, startedAt, cause);
          throw cause;
        }
      },
      catch: (cause) =>
        new WorkflowGenerationError({
          message: "Failed while polling Veo generation.",
          cause,
        }),
    });

    return yield* pollVideosOperation(
      client,
      nextOperation,
      timeoutAt,
      logContext,
    );
  });
}

export class VertexAiService extends Context.Tag("VertexAiService")<
  VertexAiService,
  {
    readonly generateImages: (params: {
      ownerUserId: string;
      projectId: string;
      request: GenerateImageRequest;
    }) => Effect.Effect<
      GenerateImageResponse,
      | WorkflowAuthorizationError
      | WorkflowConfigError
      | WorkflowGenerationError
      | WorkflowStorageError
      | WorkflowValidationError
    >;
    readonly generateText: (params: {
      ownerUserId: string;
      projectId: string;
      request: GenerateLlmRequest;
    }) => Effect.Effect<
      GenerateLlmResponse,
      | WorkflowAuthorizationError
      | WorkflowConfigError
      | WorkflowGenerationError
      | WorkflowStorageError
      | WorkflowValidationError
    >;
    readonly generateVideo: (params: {
      ownerUserId: string;
      projectId: string;
      request: GenerateVideoRequest;
    }) => Effect.Effect<
      GenerateVideoResponse,
      | WorkflowAuthorizationError
      | WorkflowConfigError
      | WorkflowGenerationError
      | WorkflowStorageError
      | WorkflowValidationError
    >;
  }
>() {
  static readonly Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const storageService = yield* StorageService;
      const location = env.GOOGLE_CLOUD_LOCATION;
      const client = yield* Effect.try({
        try: () => {
          const serviceAccountCredentials = env.GOOGLE_SERVICE_ACCOUNT_JSON
            ? (JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as {
                client_email?: string;
                private_key?: string;
                project_id?: string;
              })
            : null;
          const clientEmail =
            serviceAccountCredentials?.client_email ?? env.GOOGLE_CLIENT_EMAIL;
          const privateKey =
            serviceAccountCredentials?.private_key ??
            env.GOOGLE_PRIVATE_KEY?.replace(/\n/g, "\n");
          const projectId =
            env.GOOGLE_CLOUD_PROJECT ?? serviceAccountCredentials?.project_id;
          if (!projectId) {
            throw new Error(
              "Missing Vertex AI config. Set GOOGLE_CLOUD_PROJECT and either ADC or service account credentials.",
            );
          }

          return new GoogleGenAI({
            googleAuthOptions:
              clientEmail && privateKey
                ? {
                    credentials: {
                      client_email: clientEmail,
                      private_key: privateKey,
                    },
                  }
                : undefined,
            location,
            project: projectId,
            vertexai: true,
          });
        },
        catch: (cause) =>
          new WorkflowConfigError({
            message:
              cause instanceof Error
                ? cause.message
                : "Failed to initialize Vertex AI client.",
            cause,
          }),
      });

      const requirePrompt = (prompt: string, message: string) => {
        const promptText = prompt.trim();
        return promptText
          ? Effect.succeed(promptText)
          : Effect.fail(new WorkflowValidationError({ message }));
      };

      const toContentImagePart = (ownerUserId: string, asset: WorkflowAsset) =>
        Effect.map(
          storageService.materializeProviderMediaInput({
            assetId: asset.id,
            ownerUserId,
          }),
          (input) =>
            input.kind === "inline-bytes"
              ? createPartFromBase64(
                  input.bytes.toString("base64"),
                  input.mimeType,
                )
              : createPartFromUri(input.uri, input.mimeType),
        );

      const toSdkImage = (ownerUserId: string, asset: WorkflowAsset) =>
        Effect.gen(function* () {
          const input = yield* storageService.materializeProviderMediaInput({
            assetId: asset.id,
            ownerUserId,
          });
          if (input.kind === "inline-bytes") {
            return {
              imageBytes: input.bytes.toString("base64"),
              mimeType: input.mimeType,
            };
          }

          if (input.uri.startsWith("gs://")) {
            return {
              gcsUri: input.uri,
              mimeType: input.mimeType,
            };
          }

          return yield* Effect.fail(
            new WorkflowStorageError({
              message: `Asset ${input.assetId} URI cannot be used as a Vertex video image input.`,
            }),
          );
        });

      const toVideoReferenceImage = (
        ownerUserId: string,
        asset: WorkflowAsset,
      ) =>
        Effect.map(toSdkImage(ownerUserId, asset), (image) => ({
          image,
          referenceType: VideoGenerationReferenceType.ASSET,
        }));

      const toLlmUsage = (usage: GenerateContentResponse["usageMetadata"]) =>
        ({
          candidatesTokenCount: usage?.candidatesTokenCount ?? 0,
          promptTokenCount: usage?.promptTokenCount ?? 0,
          thoughtsTokenCount: usage?.thoughtsTokenCount ?? 0,
          totalTokenCount: usage?.totalTokenCount ?? 0,
        }) satisfies GenerateLlmUsage;

      const generateText = ({
        ownerUserId,
        projectId: _projectId,
        request: {
          idempotencyKey = null,
          model,
          mode: _mode,
          prompt,
          systemPrompt = null,
          referenceImages = [],
          temperature = 1,
          thinkingLevel = "LOW",
          maxOutputTokens = 2048,
        },
      }: {
        ownerUserId: string;
        projectId: string;
        request: GenerateLlmRequest;
      }) =>
        Effect.gen(function* () {
          const promptText = yield* requirePrompt(
            prompt,
            "Prompt is required for LLM generation.",
          );
          const systemPromptText = systemPrompt?.trim() || null;

          if (referenceImages.length > 1) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Only one image can be provided to this LLM node.",
              }),
            );
          }

          const imageParts = yield* Effect.forEach(
            referenceImages,
            (asset) => toContentImagePart(ownerUserId, asset),
            {
              concurrency: "unbounded",
            },
          );
          const response = yield* runVertexSdkCall({
            call: () =>
              client.models.generateContent({
                model,
                contents: [
                  {
                    role: "user",
                    parts: [{ text: promptText }, ...imageParts],
                  },
                ],
                config: {
                  maxOutputTokens,
                  systemInstruction: systemPromptText || undefined,
                  temperature,
                  thinkingConfig: {
                    thinkingLevel: toThinkingLevel(thinkingLevel),
                  },
                },
              }),
            errorMessage: "Vertex AI text generation failed.",
            logContext: {
              idempotencyKey,
              location,
              model,
              operation: "models.generateContent.text",
              params: {
                maxOutputTokens,
                promptLength: promptText.length,
                referenceImageCount: referenceImages.length,
                systemPromptLength: systemPromptText?.length ?? 0,
                temperature,
                thinkingLevel,
              },
            },
            result: (result) => ({
              candidatesTokenCount:
                result.usageMetadata?.candidatesTokenCount ?? 0,
              promptTokenCount: result.usageMetadata?.promptTokenCount ?? 0,
              totalTokenCount: result.usageMetadata?.totalTokenCount ?? 0,
            }),
          });
          const responseText = response.text?.trim();
          if (!responseText) {
            return yield* Effect.fail(
              new WorkflowGenerationError({
                message: "Vertex AI returned no text output.",
              }),
            );
          }

          return {
            model,
            responseText,
            usage: toLlmUsage(response.usageMetadata),
          } satisfies GenerateLlmResponse;
        });

      const generateImages = ({
        ownerUserId,
        request: {
          idempotencyKey = null,
          model,
          mode: _mode,
          prompt,
          referenceImages = [],
          aspectRatio = "1:1",
        },
      }: {
        ownerUserId: string;
        projectId: string;
        request: GenerateImageRequest;
      }) =>
        Effect.gen(function* () {
          const promptText = yield* requirePrompt(
            prompt,
            "Prompt is required for image generation.",
          );

          const imageParts = yield* Effect.forEach(
            referenceImages,
            (asset) => toContentImagePart(ownerUserId, asset),
            {
              concurrency: "unbounded",
            },
          );
          const response = yield* runVertexSdkCall({
            call: () =>
              client.models.generateContent({
                model,
                contents: [
                  {
                    role: "user",
                    parts: [{ text: promptText }, ...imageParts],
                  },
                ],
                config: {
                  responseModalities: [Modality.TEXT, Modality.IMAGE],
                  imageConfig: {
                    aspectRatio,
                    outputMimeType: "image/png",
                  },
                },
              }),
            errorMessage: "Vertex AI image generation failed.",
            logContext: {
              idempotencyKey,
              location,
              model,
              operation: "models.generateContent.image",
              params: {
                aspectRatio,
                promptLength: promptText.length,
                referenceImageCount: referenceImages.length,
              },
            },
            result: (result) => ({
              imagePartCount: pickImageParts(result).length,
            }),
          });

          const generatedParts = pickImageParts(response);
          if (!generatedParts.length) {
            return yield* Effect.fail(
              new WorkflowGenerationError({
                message: response.text || "Vertex AI returned no image output.",
              }),
            );
          }

          const assets = yield* Effect.forEach(
            Array.from(generatedParts.entries()),
            ([index, part]): Effect.Effect<
              StagedGeneratedMediaArtifact,
              | WorkflowAuthorizationError
              | WorkflowGenerationError
              | WorkflowStorageError
            > => {
              const mimeType = part.inlineData?.mimeType ?? "image/png";
              const bytes = part.inlineData?.data;

              if (!bytes) {
                return Effect.fail(
                  new WorkflowGenerationError({
                    message: "Missing image bytes in Vertex AI response.",
                  }),
                );
              }

              return storageService.stageGeneratedBufferAsArtifact({
                buffer: Buffer.from(bytes, "base64"),
                kind: "image",
                mimeType,
                fileName: `nano-banana-pro-${index + 1}.png`,
                model,
              });
            },
            { concurrency: "unbounded" },
          );

          return {
            assets,
            model,
          } satisfies GenerateImageResponse;
        });

      const generateVideo = ({
        ownerUserId,
        request: {
          idempotencyKey = null,
          model,
          mode: _mode,
          prompt,
          firstFrame,
          lastFrame,
          referenceImages = [],
          aspectRatio = "16:9",
          durationSeconds = 4,
          generateAudio = true,
          resolution = "720p",
        },
      }: {
        ownerUserId: string;
        projectId: string;
        request: GenerateVideoRequest;
      }) =>
        Effect.gen(function* () {
          const promptText = prompt.trim();
          const hasFirstLastFrame = Boolean(firstFrame || lastFrame);

          if (hasFirstLastFrame && (!firstFrame || !lastFrame)) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "First and last frame are both required for this video mode.",
              }),
            );
          }

          if (hasFirstLastFrame && referenceImages.length) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "First/last frame mode cannot use ingredient reference images.",
              }),
            );
          }

          if (!promptText && !referenceImages.length && !firstFrame) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "Prompt or reference image is required for video generation.",
              }),
            );
          }

          if (referenceImages.length && !promptText) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "Prompt is required when using ingredient images for video generation.",
              }),
            );
          }

          const sourceImage = firstFrame
            ? yield* toSdkImage(ownerUserId, firstFrame)
            : undefined;
          const lastFrameImage = lastFrame
            ? yield* toSdkImage(ownerUserId, lastFrame)
            : undefined;
          const referenceImageAssets =
            referenceImages.length > 0
              ? yield* Effect.forEach(
                  referenceImages,
                  (asset) => toVideoReferenceImage(ownerUserId, asset),
                  {
                    concurrency: "unbounded",
                  },
                )
              : undefined;
          const operation = yield* runVertexSdkCall({
            call: () =>
              client.models.generateVideos({
                model,
                source: {
                  prompt: promptText || undefined,
                  image: sourceImage,
                },
                config: {
                  numberOfVideos: 1,
                  durationSeconds,
                  aspectRatio,
                  generateAudio,
                  lastFrame: lastFrameImage,
                  resolution,
                  personGeneration: "allow_adult",
                  referenceImages: referenceImageAssets,
                },
              }),
            errorMessage: "Vertex AI video generation failed.",
            logContext: {
              idempotencyKey,
              location,
              model,
              operation: "models.generateVideos",
              params: {
                aspectRatio,
                durationSeconds,
                generateAudio,
                hasFirstFrame: Boolean(firstFrame),
                hasLastFrame: Boolean(lastFrame),
                promptLength: promptText.length,
                referenceImageCount: referenceImages.length,
                resolution,
              },
            },
            result: (result) => ({
              done: result.done ?? false,
            }),
          });

          const completedOperation = yield* pollVideosOperation(
            client,
            operation,
            Date.now() + 6 * 60 * 1000,
            {
              idempotencyKey,
              location,
              model,
              operation: "videos.getOperation",
            },
          );

          if (completedOperation.error) {
            return yield* Effect.fail(
              new WorkflowGenerationError({
                message: JSON.stringify(completedOperation.error),
              }),
            );
          }

          const generatedVideos =
            completedOperation.response?.generatedVideos ?? [];
          if (!generatedVideos.length) {
            return yield* Effect.fail(
              new WorkflowGenerationError({
                message: "Vertex AI returned no video output.",
              }),
            );
          }

          const assets: StagedGeneratedMediaArtifact[] = yield* Effect.forEach(
            Array.from(generatedVideos.entries()),
            ([index, generatedVideo]): Effect.Effect<
              StagedGeneratedMediaArtifact,
              | WorkflowAuthorizationError
              | WorkflowGenerationError
              | WorkflowStorageError
            > => {
              const video = generatedVideo.video;
              const mimeType = video?.mimeType ?? "video/mp4";

              if (video?.videoBytes) {
                return storageService.stageGeneratedBufferAsArtifact({
                  buffer: Buffer.from(video.videoBytes, "base64"),
                  kind: "video",
                  mimeType,
                  fileName: `veo-3-1-${index + 1}.mp4`,
                  model,
                });
              }

              if (video?.uri) {
                return Effect.succeed({
                  externalUri: video.uri,
                  fileName: `veo-3-1-${index + 1}.mp4`,
                  id: randomUUID(),
                  kind: "video",
                  mimeType,
                  model,
                  size: 0,
                  storageProvider: "external-staged",
                  url: video.uri,
                } satisfies StagedGeneratedMediaArtifact);
              }

              return Effect.fail(
                new WorkflowGenerationError({
                  message:
                    "Vertex AI did not return playable video bytes or a URI.",
                }),
              );
            },
            { concurrency: "unbounded" },
          );

          return {
            assets,
            model,
          } satisfies GenerateVideoResponse;
        });

      return VertexAiService.of({
        generateImages,
        generateText,
        generateVideo,
      });
    }),
  );
}
