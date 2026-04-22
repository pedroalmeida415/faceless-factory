import {
  createPartFromBase64,
  createPartFromUri,
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  VideoGenerationReferenceType,
} from "@google/genai";
import { Context, Effect, Layer } from "effect";

import {
  type WorkflowAuthorizationError,
  WorkflowConfigError,
  WorkflowGenerationError,
  WorkflowStorageError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import {
  GEMINI_3_FLASH_PREVIEW_MODEL_ID,
  type GenerateImageRequest,
  type GenerateImageResponse,
  type GenerateLlmRequest,
  type GenerateLlmResponse,
  type GenerateLlmUsage,
  type GenerateVideoRequest,
  type GenerateVideoResponse,
  type LlmThinkingLevel,
  NANO_BANANA_PRO_MODEL_ID,
  VEO_31_MODEL_ID,
  type WorkflowAsset,
} from "~/lib/workflow/types";
import { WorkflowStorage } from "~/server/workflow/storage";

type GenerateContentResponse = Awaited<
  ReturnType<GoogleGenAI["models"]["generateContent"]>
>;

type GenerateVideosOperation = Awaited<
  ReturnType<GoogleGenAI["models"]["generateVideos"]>
>;

function readServiceAccountCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) as {
      client_email?: string;
      private_key?: string;
      project_id?: string;
    };
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
      projectId: parsed.project_id,
    };
  }

  return {
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    projectId: undefined,
  };
}

function getGoogleProjectId() {
  const credentials = readServiceAccountCredentials();
  return process.env.GOOGLE_CLOUD_PROJECT ?? credentials.projectId ?? null;
}

function getGoogleAuthOptions() {
  const credentials = readServiceAccountCredentials();
  if (!credentials.clientEmail || !credentials.privateKey) {
    return undefined;
  }

  return {
    credentials: {
      client_email: credentials.clientEmail,
      private_key: credentials.privateKey,
    },
  };
}

function createVertexClient(location: string) {
  const projectId = getGoogleProjectId();
  if (!projectId) {
    throw new Error(
      "Missing Vertex AI config. Set GOOGLE_CLOUD_PROJECT and either ADC or service account credentials.",
    );
  }

  return new GoogleGenAI({
    vertexai: true,
    project: projectId,
    location,
    googleAuthOptions: getGoogleAuthOptions(),
  });
}

function createVertexClientEffect(location: string) {
  return Effect.try({
    try: () => createVertexClient(location),
    catch: (cause) =>
      new WorkflowConfigError({
        message:
          cause instanceof Error
            ? cause.message
            : "Failed to initialize Vertex AI client.",
        cause,
      }),
  });
}

function getImageLocation() {
  return process.env.GOOGLE_CLOUD_LOCATION_IMAGE ?? "global";
}

function getVideoLocation() {
  const sharedLocation = process.env.GOOGLE_CLOUD_LOCATION;
  if (process.env.GOOGLE_CLOUD_LOCATION_VIDEO) {
    return process.env.GOOGLE_CLOUD_LOCATION_VIDEO;
  }
  if (sharedLocation && sharedLocation !== "global") {
    return sharedLocation;
  }
  return "us-central1";
}

function getLlmLocation() {
  return process.env.GOOGLE_CLOUD_LOCATION_LLM ?? "global";
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
      try: () => client.operations.getVideosOperation({ operation }),
      catch: (cause) =>
        new WorkflowGenerationError({
          message: "Failed while polling Veo generation.",
          cause,
        }),
    });

    return yield* pollVideosOperation(client, nextOperation, timeoutAt);
  });
}

export class VertexAi extends Context.Tag("VertexAi")<
  VertexAi,
  {
    readonly countTokensForGemini3Flash: (params: {
      ownerUserId: string;
      request: GenerateLlmRequest;
    }) => Effect.Effect<
      { totalTokens: number },
      | WorkflowAuthorizationError
      | WorkflowConfigError
      | WorkflowGenerationError
      | WorkflowStorageError
      | WorkflowValidationError
    >;
    readonly generateImagesWithNanoBananaPro: (params: {
      ownerUserId: string;
      projectId?: string | null;
      request: GenerateImageRequest;
    }) => Effect.Effect<
      GenerateImageResponse,
      | WorkflowAuthorizationError
      | WorkflowConfigError
      | WorkflowGenerationError
      | WorkflowStorageError
      | WorkflowValidationError
    >;
    readonly generateTextWithGemini3Flash: (params: {
      ownerUserId: string;
      projectId?: string | null;
      request: GenerateLlmRequest;
    }) => Effect.Effect<
      GenerateLlmResponse,
      | WorkflowAuthorizationError
      | WorkflowConfigError
      | WorkflowGenerationError
      | WorkflowStorageError
      | WorkflowValidationError
    >;
    readonly generateVideosWithVeo31: (params: {
      ownerUserId: string;
      projectId?: string | null;
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
  static readonly functions = Effect.serviceFunctions(this);

  static readonly Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const workflowStorage = yield* WorkflowStorage;

      const toInlineImagePart = (asset: WorkflowAsset) =>
        Effect.gen(function* () {
          const buffer = yield* workflowStorage.readStoredAsset(asset);
          return {
            inlineData: {
              data: buffer.toString("base64"),
              mimeType: asset.mimeType,
            },
          };
        });

      const toSdkImage = (asset: WorkflowAsset) =>
        Effect.gen(function* () {
          const buffer = yield* workflowStorage.readStoredAsset(asset);
          return {
            imageBytes: buffer.toString("base64"),
            mimeType: asset.mimeType,
          };
        });

      const toVideoReferenceImage = (asset: WorkflowAsset) =>
        Effect.map(toSdkImage(asset), (image) => ({
          image,
          referenceType: VideoGenerationReferenceType.ASSET,
        }));

      const toLlmImagePart = (ownerUserId: string, asset: WorkflowAsset) =>
        Effect.gen(function* () {
          const storedAsset = yield* workflowStorage.readAssetById({
            assetId: asset.id,
            userId: ownerUserId,
          });

          if (storedAsset.data) {
            return createPartFromBase64(
              storedAsset.data.toString("base64"),
              storedAsset.mimeType,
            );
          }

          if (storedAsset.externalUri) {
            return createPartFromUri(
              storedAsset.externalUri,
              storedAsset.mimeType,
            );
          }

          return yield* Effect.fail(
            new WorkflowStorageError({
              message: `Asset ${asset.id} could not be loaded for LLM input.`,
            }),
          );
        });

      const toLlmUsage = (usage: GenerateContentResponse["usageMetadata"]) =>
        ({
          candidatesTokenCount: usage?.candidatesTokenCount ?? 0,
          promptTokenCount: usage?.promptTokenCount ?? 0,
          thoughtsTokenCount: usage?.thoughtsTokenCount ?? 0,
          totalTokenCount: usage?.totalTokenCount ?? 0,
        }) satisfies GenerateLlmUsage;

      const countTokensForGemini3Flash = ({
        ownerUserId,
        request: { prompt, referenceImages = [], systemPrompt = null },
      }: {
        ownerUserId: string;
        request: GenerateLlmRequest;
      }) =>
        Effect.gen(function* () {
          const promptText = prompt.trim();
          if (!promptText) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Prompt is required for LLM generation.",
              }),
            );
          }

          if (referenceImages.length > 1) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Only one image can be provided to this LLM node.",
              }),
            );
          }

          const client = yield* createVertexClientEffect(getLlmLocation());
          const imageParts = yield* Effect.forEach(
            referenceImages,
            (asset) => toLlmImagePart(ownerUserId, asset),
            {
              concurrency: "unbounded",
            },
          );
          const response = yield* Effect.tryPromise({
            try: () =>
              client.models.countTokens({
                model: GEMINI_3_FLASH_PREVIEW_MODEL_ID,
                contents: [
                  {
                    role: "user",
                    parts: [{ text: promptText }, ...imageParts],
                  },
                ],
                config: {
                  systemInstruction: systemPrompt?.trim() || undefined,
                },
              }),
            catch: (cause) =>
              new WorkflowGenerationError({
                message: "Vertex AI token counting failed.",
                cause,
              }),
          });

          return {
            totalTokens: response.totalTokens ?? 0,
          };
        });

      const generateTextWithGemini3Flash = ({
        ownerUserId,
        projectId: _projectId = null,
        request: {
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
        projectId?: string | null;
        request: GenerateLlmRequest;
      }) =>
        Effect.gen(function* () {
          const promptText = prompt.trim();
          const systemPromptText = systemPrompt?.trim() || null;
          if (!promptText) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Prompt is required for LLM generation.",
              }),
            );
          }

          if (referenceImages.length > 1) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Only one image can be provided to this LLM node.",
              }),
            );
          }

          const client = yield* createVertexClientEffect(getLlmLocation());
          const imageParts = yield* Effect.forEach(
            referenceImages,
            (asset) => toLlmImagePart(ownerUserId, asset),
            {
              concurrency: "unbounded",
            },
          );
          const response = yield* Effect.tryPromise({
            try: () =>
              client.models.generateContent({
                model: GEMINI_3_FLASH_PREVIEW_MODEL_ID,
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
            catch: (cause) =>
              new WorkflowGenerationError({
                message: "Vertex AI text generation failed.",
                cause,
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

      const generateImagesWithNanoBananaPro = ({
        ownerUserId,
        projectId = null,
        request: {
          model,
          mode: _mode,
          prompt,
          referenceImages = [],
          aspectRatio = "1:1",
        },
      }: {
        ownerUserId: string;
        projectId?: string | null;
        request: GenerateImageRequest;
      }) =>
        Effect.gen(function* () {
          const promptText = prompt.trim();
          if (!promptText) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Prompt is required for image generation.",
              }),
            );
          }

          const client = yield* createVertexClientEffect(getImageLocation());
          const imageParts = yield* Effect.forEach(
            referenceImages,
            toInlineImagePart,
            {
              concurrency: "unbounded",
            },
          );
          const response = yield* Effect.tryPromise({
            try: () =>
              client.models.generateContent({
                model: NANO_BANANA_PRO_MODEL_ID,
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
            catch: (cause) =>
              new WorkflowGenerationError({
                message: "Vertex AI image generation failed.",
                cause,
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

          const assets: WorkflowAsset[] = yield* Effect.forEach(
            Array.from(generatedParts.entries()),
            ([index, part]): Effect.Effect<
              WorkflowAsset,
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

              return workflowStorage.saveBufferAsAsset({
                buffer: Buffer.from(bytes, "base64"),
                kind: "image",
                source: "generated",
                mimeType,
                fileName: `nano-banana-pro-${index + 1}.png`,
                model: NANO_BANANA_PRO_MODEL_ID,
                ownerUserId,
                projectId,
              });
            },
            { concurrency: "unbounded" },
          );

          return {
            assets,
            responseText: response.text || null,
            model,
          } satisfies GenerateImageResponse;
        });

      const generateVideosWithVeo31 = ({
        ownerUserId,
        projectId = null,
        request: {
          model,
          mode: _mode,
          prompt,
          referenceImages = [],
          aspectRatio = "16:9",
          durationSeconds = 4,
          generateAudio = true,
          resolution = "720p",
        },
      }: {
        ownerUserId: string;
        projectId?: string | null;
        request: GenerateVideoRequest;
      }) =>
        Effect.gen(function* () {
          const promptText = prompt.trim();
          const inputImages = referenceImages;

          if (!promptText && !inputImages.length) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "Prompt or reference image is required for video generation.",
              }),
            );
          }

          if (inputImages.length > 1 && !promptText) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "Prompt is required when using multiple reference images for video generation.",
              }),
            );
          }

          const client = yield* createVertexClientEffect(getVideoLocation());
          const sourceImage =
            inputImages.length === 1
              ? yield* toSdkImage(inputImages[0] as WorkflowAsset)
              : undefined;
          const referenceImageAssets =
            inputImages.length > 1
              ? yield* Effect.forEach(inputImages, toVideoReferenceImage, {
                  concurrency: "unbounded",
                })
              : undefined;
          const operation = yield* Effect.tryPromise({
            try: () =>
              client.models.generateVideos({
                model: VEO_31_MODEL_ID,
                source: {
                  prompt: promptText || undefined,
                  image: sourceImage,
                },
                config: {
                  numberOfVideos: 1,
                  durationSeconds,
                  aspectRatio,
                  generateAudio,
                  resolution,
                  personGeneration: "allow_adult",
                  referenceImages: referenceImageAssets,
                },
              }),
            catch: (cause) =>
              new WorkflowGenerationError({
                message: "Vertex AI video generation failed.",
                cause,
              }),
          });

          const completedOperation = yield* pollVideosOperation(
            client,
            operation,
            Date.now() + 6 * 60 * 1000,
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

          const assets: WorkflowAsset[] = yield* Effect.forEach(
            Array.from(generatedVideos.entries()),
            ([index, generatedVideo]): Effect.Effect<
              WorkflowAsset,
              | WorkflowAuthorizationError
              | WorkflowGenerationError
              | WorkflowStorageError
            > => {
              const video = generatedVideo.video;
              const mimeType = video?.mimeType ?? "video/mp4";

              if (video?.videoBytes) {
                return workflowStorage.saveBufferAsAsset({
                  buffer: Buffer.from(video.videoBytes, "base64"),
                  kind: "video",
                  source: "generated",
                  mimeType,
                  fileName: `veo-3-1-${index + 1}.mp4`,
                  model: VEO_31_MODEL_ID,
                  ownerUserId,
                  projectId,
                });
              }

              if (video?.uri) {
                return workflowStorage.saveExternalAsset({
                  fileName: `veo-3-1-${index + 1}.mp4`,
                  kind: "video",
                  mimeType,
                  model: VEO_31_MODEL_ID,
                  ownerUserId,
                  projectId,
                  source: "generated",
                  url: video.uri,
                });
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

      return VertexAi.of({
        countTokensForGemini3Flash,
        generateImagesWithNanoBananaPro,
        generateTextWithGemini3Flash,
        generateVideosWithVeo31,
      });
    }),
  );
}
