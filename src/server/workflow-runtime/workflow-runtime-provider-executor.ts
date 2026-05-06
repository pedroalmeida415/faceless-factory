import { randomUUID } from "node:crypto";

import { Cause, Effect } from "effect";
import type {
  GenerateImageRequest,
  GenerateImageResponse,
  GenerateLlmRequest,
  GenerateLlmResponse,
  GenerateVideoRequest,
  GenerateVideoResponse,
  StagedGeneratedMediaArtifact,
} from "~/lib/workflow/types";
import type { ExecutableTaskRunInputSnapshot } from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
import {
  priceImageGeneration,
  priceLlmGeneration,
  priceVideoGeneration,
} from "~/server/workflow/pricing-catalog";
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
  readonly vertexAi: WorkflowRuntimeVertexProvider;
}): WorkflowRuntimeProviderExecutor {
  const createAssetId = input.createAssetId ?? randomUUID;

  return {
    execute(command) {
      const { inputSnapshot, ownerUserId, workflowId } = command;
      const requestParams = {
        ownerUserId,
        projectId: workflowId,
      };
      const providerInput = inputSnapshot.providerInput;

      return Effect.suspend(() => {
        switch (providerInput.kind) {
          case "image-generation-request": {
            return Effect.map(
              input.vertexAi.generateImagesWithNanoBananaPro({
                ...requestParams,
                request: providerInput.request,
              }),
              (response) =>
                generatedMediaResult({
                  assets: response.assets,
                  expectedKind: "image",
                  providerCostCredits: priceImageGeneration(
                    providerInput.request,
                  ),
                  reviewRequired: getReviewRequired(inputSnapshot),
                }),
            );
          }
          case "video-generation-request": {
            return Effect.map(
              input.vertexAi.generateVideosWithVeo31({
                ...requestParams,
                request: providerInput.request,
              }),
              (response) =>
                generatedMediaResult({
                  assets: response.assets,
                  expectedKind: "video",
                  providerCostCredits: priceVideoGeneration(
                    providerInput.request,
                  ),
                  reviewRequired: getReviewRequired(inputSnapshot),
                }),
            );
          }
          case "llm-generation-request": {
            return Effect.map(
              input.vertexAi.generateTextWithGemini3Flash({
                ...requestParams,
                request: providerInput.request,
              }),
              (response) =>
                ({
                  ok: true,
                  value: {
                    providerCostCredits: priceLlmGeneration(response),
                    generatedAsset: {
                      assetId: createAssetId(),
                      contentType: "text/plain; charset=utf-8",
                      fileName: `${inputSnapshot.taskRunId}.txt`,
                      kind: "text",
                      model: response.model,
                      sizeBytes: Buffer.byteLength(
                        response.responseText,
                        "utf8",
                      ),
                      storageProvider: "inline",
                      text: response.responseText,
                    },
                    reviewRequired: getReviewRequired(inputSnapshot),
                  },
                }) satisfies ProviderExecutionResult,
            );
          }
        }
      }).pipe(
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.succeed({
                error: {
                  failureReason: {
                    message: providerFailureMessage(Cause.squash(cause)),
                    type: "PROVIDER_FAILED",
                  },
                  failureSource: nonRefundableProviderFailureSource(),
                },
                ok: false,
              } satisfies ProviderExecutionResult),
        ),
      );
    },
  };
}

function generatedMediaResult(input: {
  readonly assets: readonly StagedGeneratedMediaArtifact[];
  readonly expectedKind: "image" | "video";
  readonly providerCostCredits: number;
  readonly reviewRequired: boolean;
}): ProviderExecutionResult {
  if (input.assets.length !== 1) {
    return {
      error: {
        failureReason: {
          message: `Provider returned ${input.assets.length} ${input.expectedKind} assets; exactly one primary asset is required.`,
          type: "PROVIDER_FAILED",
        },
        failureSource: nonRefundableProviderFailureSource(),
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
        failureSource: nonRefundableProviderFailureSource(),
      },
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      providerCostCredits: input.providerCostCredits,
      generatedAsset: toGeneratedMediaAssetPayload(asset, input.expectedKind),
      reviewRequired: input.reviewRequired,
    },
  };
}

function toGeneratedMediaAssetPayload(
  asset: StagedGeneratedMediaArtifact,
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
    storageKey:
      asset.storageProvider === "local-staged"
        ? asset.promotedStoragePath
        : null,
    storageProvider:
      asset.storageProvider === "local-staged" ? "local" : "external",
    stagedStorageKey:
      asset.storageProvider === "local-staged" ? asset.stagedStoragePath : null,
  };
}

function getReviewRequired(snapshot: ExecutableTaskRunInputSnapshot) {
  const node = snapshot.targetNodeConfig;

  return "reviewEnabled" in node ? node.reviewEnabled : false;
}

function nonRefundableProviderFailureSource() {
  return {
    taskRunDebitRefundable: false,
    type: "PROVIDER",
  } as const;
}

function providerFailureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "Provider execution failed.";
}
