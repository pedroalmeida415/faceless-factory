import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import { Effect } from "effect";

import { createWorkflowNode } from "~/lib/workflow/document";
import type { StagedGeneratedMediaArtifact } from "~/lib/workflow/types";
import type { ExecutableTaskRunInputSnapshot } from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
import { createWorkflowRuntimeProviderExecutor } from "~/server/workflow-runtime/workflow-runtime-provider-executor";

describe("WorkflowRuntimeProviderExecutor", () => {
  test("executes an image generation request and returns the single generated asset", async () => {
    const vertexAi = new FakeVertexAi();
    vertexAi.imageResponse = {
      assets: [workflowAsset({ id: "image-asset-1", kind: "image" })],
      model: "gemini-3-pro-image-preview",
    };
    const executor = createWorkflowRuntimeProviderExecutor({ vertexAi });
    const snapshot = inputSnapshot({ kind: "imageGenerator" });

    const result = await executor.execute({
      inputSnapshot: snapshot,
      ownerUserId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.deepEqual(vertexAi.imageCalls, [
      {
        ownerUserId: "owner-1",
        projectId: "workflow-1",
        request: snapshot.providerInput.request,
      },
    ]);
    assert.deepEqual(result, {
      ok: true,
      value: {
        providerCostCredits: 10,
        generatedAsset: {
          assetId: "image-asset-1",
          cdnUrl: "/api/assets/image-asset-1",
          contentType: "image/png",
          externalUri: null,
          fileName: "image-asset-1.png",
          kind: "image",
          model: "gemini-3-pro-image-preview",
          sizeBytes: 123,
          stagedStorageKey: "staged-generated/image/image-asset-1.png",
          storageKey: "generated/image/image-asset-1.png",
          storageProvider: "local",
        },
        reviewRequired: false,
      },
    });
  });

  test("executes a video generation request and returns the single generated asset", async () => {
    const vertexAi = new FakeVertexAi();
    vertexAi.videoResponse = {
      assets: [workflowAsset({ id: "video-asset-1", kind: "video" })],
      model: "veo-3.1-fast-generate-001",
    };
    const executor = createWorkflowRuntimeProviderExecutor({ vertexAi });
    const snapshot = inputSnapshot({ kind: "videoGenerator" });

    const result = await executor.execute({
      inputSnapshot: snapshot,
      ownerUserId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.deepEqual(vertexAi.videoCalls, [
      {
        ownerUserId: "owner-1",
        projectId: "workflow-1",
        request: snapshot.providerInput.request,
      },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value.providerCostCredits : null, 40);
    assert.deepEqual(result.ok ? result.value.generatedAsset : null, {
      assetId: "video-asset-1",
      cdnUrl: "/api/assets/video-asset-1",
      contentType: "video/mp4",
      externalUri: null,
      fileName: "video-asset-1.mp4",
      kind: "video",
      model: "veo-3.1-fast-generate-001",
      sizeBytes: 123,
      stagedStorageKey: "staged-generated/video/video-asset-1.mp4",
      storageKey: "generated/video/video-asset-1.mp4",
      storageProvider: "local",
    });
  });

  test("executes an LLM generation request and returns an inline text asset with usage cost", async () => {
    const vertexAi = new FakeVertexAi();
    vertexAi.llmResponse = {
      model: "gemini-3-flash-preview",
      responseText: "Generated script",
      usage: {
        candidatesTokenCount: 1_000_000,
        promptTokenCount: 2_000_000,
        thoughtsTokenCount: 500_000,
        totalTokenCount: 3_500_000,
      },
    };
    const executor = createWorkflowRuntimeProviderExecutor({
      createAssetId: () => "text-asset-1",
      vertexAi,
    });
    const snapshot = inputSnapshot({ kind: "llmGenerator" });

    const result = await executor.execute({
      inputSnapshot: snapshot,
      ownerUserId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.deepEqual(vertexAi.llmCalls, [
      {
        ownerUserId: "owner-1",
        projectId: "workflow-1",
        request: snapshot.providerInput.request,
      },
    ]);
    assert.deepEqual(result, {
      ok: true,
      value: {
        providerCostCredits: 550,
        generatedAsset: {
          assetId: "text-asset-1",
          contentType: "text/plain; charset=utf-8",
          fileName: "task-run-1.txt",
          kind: "text",
          model: "gemini-3-flash-preview",
          sizeBytes: 16,
          storageProvider: "inline",
          text: "Generated script",
        },
        reviewRequired: false,
      },
    });
  });

  test("uses the immutable snapshot provider input for the provider call", async () => {
    const vertexAi = new FakeVertexAi();
    const executor = createWorkflowRuntimeProviderExecutor({
      createAssetId: () => "text-asset-frozen",
      vertexAi,
    });
    const baseSnapshot = inputSnapshot({ kind: "llmGenerator" });
    if (baseSnapshot.targetNodeConfig.kind !== "llmGenerator") {
      throw new Error("Expected LLM generator target node config");
    }
    const snapshot = {
      ...baseSnapshot,
      providerInput: {
        kind: "llm-generation-request" as const,
        request: {
          idempotencyKey: "task_run:task-run-1:attempt:0",
          maxOutputTokens: 512,
          mode: null,
          model: "gemini-3-flash-preview" as const,
          prompt: "frozen snapshot prompt",
          referenceImages: [],
          systemPrompt: "frozen system prompt",
          temperature: 0.3,
          thinkingLevel: "LOW" as const,
        },
      },
      targetNodeConfig: {
        ...baseSnapshot.targetNodeConfig,
        config: { maxOutputTokens: 2048, temperature: 1, thinkingLevel: "LOW" },
      },
    } satisfies ExecutableTaskRunInputSnapshot;

    await executor.execute({
      inputSnapshot: snapshot,
      ownerUserId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.deepEqual(
      vertexAi.llmCalls.map((call) => call.request),
      [snapshot.providerInput.request],
    );
  });

  test("rejects multiple generated media assets instead of picking one", async () => {
    const vertexAi = new FakeVertexAi();
    vertexAi.imageResponse = {
      assets: [
        workflowAsset({ id: "image-asset-1", kind: "image" }),
        workflowAsset({ id: "image-asset-2", kind: "image" }),
      ],
      model: "gemini-3-pro-image-preview",
    };
    const executor = createWorkflowRuntimeProviderExecutor({ vertexAi });

    const result = await executor.execute({
      inputSnapshot: inputSnapshot({ kind: "imageGenerator" }),
      ownerUserId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.deepEqual(result, {
      error: {
        failureReason: {
          message:
            "Provider returned 2 image assets; exactly one primary asset is required.",
          type: "PROVIDER_FAILED",
        },
        failureSource: {
          taskRunDebitRefundable: false,
          type: "PROVIDER",
        },
      },
      ok: false,
    });
  });

  test("maps provider thrown errors to provider failure", async () => {
    const vertexAi = new FakeVertexAi();
    vertexAi.thrownError = new Error("Vertex quota exhausted");
    const executor = createWorkflowRuntimeProviderExecutor({ vertexAi });

    const result = await executor.execute({
      inputSnapshot: inputSnapshot({ kind: "imageGenerator" }),
      ownerUserId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.deepEqual(result, {
      error: {
        failureReason: {
          message: "Vertex quota exhausted",
          type: "PROVIDER_FAILED",
        },
        failureSource: {
          taskRunDebitRefundable: false,
          type: "PROVIDER",
        },
      },
      ok: false,
    });
  });

  test("propagates reviewRequired from generator target node config", async () => {
    const vertexAi = new FakeVertexAi();
    vertexAi.imageResponse = {
      assets: [workflowAsset({ id: "image-asset-1", kind: "image" })],
      model: "gemini-3-pro-image-preview",
    };
    const executor = createWorkflowRuntimeProviderExecutor({ vertexAi });

    const result = await executor.execute({
      inputSnapshot: inputSnapshot({
        kind: "imageGenerator",
        reviewEnabled: true,
      }),
      ownerUserId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.equal(result.ok ? result.value.reviewRequired : false, true);
  });
});

class FakeVertexAi {
  imageCalls: Parameters<VertexLike["generateImagesWithNanoBananaPro"]>[0][] =
    [];
  llmCalls: Parameters<VertexLike["generateTextWithGemini3Flash"]>[0][] = [];
  videoCalls: Parameters<VertexLike["generateVideosWithVeo31"]>[0][] = [];
  thrownError: Error | null = null;
  imageResponse: GenerateEffectSuccess<
    ReturnType<VertexLike["generateImagesWithNanoBananaPro"]>
  > = { assets: [], model: "gemini-3-pro-image-preview" };
  llmResponse: GenerateEffectSuccess<
    ReturnType<VertexLike["generateTextWithGemini3Flash"]>
  > = {
    model: "gemini-3-flash-preview",
    responseText: "",
    usage: {
      candidatesTokenCount: 0,
      promptTokenCount: 0,
      thoughtsTokenCount: 0,
      totalTokenCount: 0,
    },
  };
  videoResponse: GenerateEffectSuccess<
    ReturnType<VertexLike["generateVideosWithVeo31"]>
  > = { assets: [], model: "veo-3.1-fast-generate-001" };

  generateImagesWithNanoBananaPro(
    params: Parameters<VertexLike["generateImagesWithNanoBananaPro"]>[0],
  ) {
    this.imageCalls.push(params);
    if (this.thrownError) {
      throw this.thrownError;
    }

    return Effect.succeed(this.imageResponse);
  }

  generateVideosWithVeo31(
    params: Parameters<VertexLike["generateVideosWithVeo31"]>[0],
  ) {
    this.videoCalls.push(params);

    return Effect.succeed(this.videoResponse);
  }

  generateTextWithGemini3Flash(
    params: Parameters<VertexLike["generateTextWithGemini3Flash"]>[0],
  ) {
    this.llmCalls.push(params);

    return Effect.succeed(this.llmResponse);
  }
}

type VertexLike = Parameters<
  typeof createWorkflowRuntimeProviderExecutor
>[0]["vertexAi"];
type GenerateEffectSuccess<T> =
  T extends Effect.Effect<infer A, unknown> ? A : never;

function inputSnapshot(input: {
  kind: "imageGenerator" | "videoGenerator" | "llmGenerator";
  reviewEnabled?: boolean;
}): ExecutableTaskRunInputSnapshot {
  const targetNodeConfig = {
    ...createWorkflowNode(input.kind, 0),
    id: "node-1",
    reviewEnabled: input.reviewEnabled ?? false,
  };
  const providerInput = renderProviderInput(input.kind);

  return {
    attempt: 0,
    documentRevision: null,
    idempotencyKey: "task_run:task-run-1:attempt:0",
    itemIndex: 0,
    kind: "task-run-input-snapshot",
    nodeExecutionId: "node-execution-1",
    nodeId: "node-1",
    providerInput,
    resolvedParentTaskRuns: [],
    targetNodeConfig,
    taskRunId: "task-run-1",
    version: 1,
    workflowDefinition: {
      edges: [],
      nodes: [targetNodeConfig],
      version: 9,
    },
  };
}

function renderProviderInput(
  kind: "imageGenerator" | "videoGenerator" | "llmGenerator",
) {
  switch (kind) {
    case "imageGenerator":
      return {
        kind: "image-generation-request" as const,
        request: {
          aspectRatio: "1:1" as const,
          idempotencyKey: "task_run:task-run-1:attempt:0",
          mode: null,
          model: "gemini-3-pro-image-preview" as const,
          prompt: "make an image",
          referenceImages: [],
        },
      };
    case "videoGenerator":
      return {
        kind: "video-generation-request" as const,
        request: {
          aspectRatio: "16:9" as const,
          durationSeconds: 4 as const,
          generateAudio: true,
          idempotencyKey: "task_run:task-run-1:attempt:0",
          mode: null,
          model: "veo-3.1-fast-generate-001" as const,
          prompt: "make a video",
          referenceImages: [],
          resolution: "720p" as const,
        },
      };
    case "llmGenerator":
      return {
        kind: "llm-generation-request" as const,
        request: {
          idempotencyKey: "task_run:task-run-1:attempt:0",
          maxOutputTokens: 2048,
          mode: null,
          model: "gemini-3-flash-preview" as const,
          prompt: "write a script",
          referenceImages: [],
          systemPrompt: null,
          temperature: 1,
          thinkingLevel: "LOW" as const,
        },
      };
  }
}

function workflowAsset(input: {
  id: string;
  kind: "image" | "video";
}): StagedGeneratedMediaArtifact {
  return {
    externalUri: null,
    fileName: `${input.id}.${input.kind === "image" ? "png" : "mp4"}`,
    id: input.id,
    kind: input.kind,
    mimeType: input.kind === "image" ? "image/png" : "video/mp4",
    model:
      input.kind === "image"
        ? "gemini-3-pro-image-preview"
        : "veo-3.1-fast-generate-001",
    size: 123,
    promotedStoragePath: `generated/${input.kind}/${input.id}.${input.kind === "image" ? "png" : "mp4"}`,
    stagedStoragePath: `staged-generated/${input.kind}/${input.id}.${input.kind === "image" ? "png" : "mp4"}`,
    storageProvider: "local-staged",
    url: `/api/assets/${input.id}`,
  };
}
