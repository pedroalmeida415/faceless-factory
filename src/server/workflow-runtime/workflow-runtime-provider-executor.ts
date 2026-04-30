import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import { calculateLlmUsageCreditCost } from "~/lib/workflow/llm-models";
import type {
  GenerateImageRequest,
  GenerateImageResponse,
  GenerateLlmRequest,
  GenerateLlmResponse,
  GenerateVideoRequest,
  GenerateVideoResponse,
  WorkflowAsset,
} from "~/lib/workflow/types";
import type { ExecutableTaskRunInputSnapshot } from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
import type {
  ProviderExecutionResult,
  WorkflowRuntimeProviderExecutor,
} from "~/server/workflow-runtime/workflow-runtime-execution-worker";
import type { WorkflowRuntimeGeneratedPrimaryAssetPayload } from "~/server/workflow-runtime/workflow-runtime-queue";

export type WorkflowRuntimeVertexProvider = {
  readonly generateImagesWithNanoBananaPro: (params: {
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly request: GenerateImageRequest;
  }) => Effect.Effect<GenerateImageResponse, unknown>;
  readonly generateTextWithGemini3Flash: (params: {
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly request: GenerateLlmRequest;
  }) => Effect.Effect<GenerateLlmResponse, unknown>;
  readonly generateVideosWithVeo31: (params: {
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly request: GenerateVideoRequest;
  }) => Effect.Effect<GenerateVideoResponse, unknown>;
};

export function createWorkflowRuntimeProviderExecutor(input: {
  readonly createAssetId?: () => string;
  readonly runEffect?: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  readonly vertexAi: WorkflowRuntimeVertexProvider;
}): WorkflowRuntimeProviderExecutor {
  const createAssetId = input.createAssetId ?? randomUUID;
  const runEffect = input.runEffect ?? Effect.runPromise;

  return {
    async execute(command) {
      const { inputSnapshot, ownerUserId, workflowId } = command;
      const requestParams = {
        ownerUserId,
        projectId: workflowId,
      };

      try {
        switch (inputSnapshot.providerInput.kind) {
          case "image-generation-request": {
            const response = await runEffect(
              input.vertexAi.generateImagesWithNanoBananaPro({
                ...requestParams,
                request: inputSnapshot.providerInput.request,
              }),
            );

            return generatedMediaResult({
              assets: response.assets,
              expectedKind: "image",
              finalCostCredits: 0,
              reviewRequired: getReviewRequired(inputSnapshot),
            });
          }
          case "video-generation-request": {
            const response = await runEffect(
              input.vertexAi.generateVideosWithVeo31({
                ...requestParams,
                request: inputSnapshot.providerInput.request,
              }),
            );

            return generatedMediaResult({
              assets: response.assets,
              expectedKind: "video",
              finalCostCredits: 0,
              reviewRequired: getReviewRequired(inputSnapshot),
            });
          }
          case "llm-generation-request": {
            const response = await runEffect(
              input.vertexAi.generateTextWithGemini3Flash({
                ...requestParams,
                request: inputSnapshot.providerInput.request,
              }),
            );

            return {
              ok: true,
              value: {
                finalCostCredits: calculateLlmUsageCreditCost({
                  model: response.model,
                  usage: response.usage,
                }),
                generatedAsset: {
                  assetId: createAssetId(),
                  contentType: "text/plain; charset=utf-8",
                  fileName: `${inputSnapshot.taskRunId}.txt`,
                  kind: "text",
                  model: response.model,
                  sizeBytes: Buffer.byteLength(response.responseText, "utf8"),
                  storageProvider: "inline",
                  text: response.responseText,
                },
                reviewRequired: getReviewRequired(inputSnapshot),
              },
            } satisfies ProviderExecutionResult;
          }
        }
      } catch (cause) {
        return {
          error: {
            failureReason: {
              message: providerFailureMessage(cause),
              type: "PROVIDER_FAILED",
            },
          },
          ok: false,
        } satisfies ProviderExecutionResult;
      }
    },
  };
}

function generatedMediaResult(input: {
  readonly assets: readonly WorkflowAsset[];
  readonly expectedKind: "image" | "video";
  readonly finalCostCredits: number;
  readonly reviewRequired: boolean;
}): ProviderExecutionResult {
  if (input.assets.length !== 1) {
    return {
      error: {
        failureReason: {
          message: `Provider returned ${input.assets.length} ${input.expectedKind} assets; exactly one primary asset is required.`,
          type: "PROVIDER_FAILED",
        },
      },
      ok: false,
    };
  }

  const asset = input.assets[0];
  if (!asset || asset.kind !== input.expectedKind) {
    return {
      error: {
        failureReason: {
          message: `Provider returned an invalid ${input.expectedKind} asset.`,
          type: "PROVIDER_FAILED",
        },
      },
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      finalCostCredits: input.finalCostCredits,
      generatedAsset: toGeneratedMediaAssetPayload(asset, input.expectedKind),
      reviewRequired: input.reviewRequired,
    },
  };
}

function toGeneratedMediaAssetPayload(
  asset: WorkflowAsset,
  kind: "image" | "video",
): WorkflowRuntimeGeneratedPrimaryAssetPayload {
  return {
    assetId: asset.id,
    cdnUrl: asset.url,
    contentType: asset.mimeType,
    externalUri: asset.externalUri,
    fileName: asset.fileName,
    kind,
    model: asset.model,
    sizeBytes: asset.size,
    storageKey: asset.storagePath,
    storageProvider: asset.storagePath ? "local" : "external",
  };
}

function getReviewRequired(snapshot: ExecutableTaskRunInputSnapshot) {
  const node = snapshot.targetNodeConfig;

  return "reviewEnabled" in node ? node.reviewEnabled : false;
}

function providerFailureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "Provider execution failed.";
}
