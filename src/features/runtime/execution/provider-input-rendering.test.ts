import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { renderTaskRunProviderInput } from "~/features/runtime/execution/provider-input-rendering";
import type { ResolvedParentTaskRunInputSnapshot } from "~/features/runtime/execution/task-run-input-snapshot";
import type { MaterializedProviderInputFacts } from "~/features/runtime/materialization/task-run-input-materialization";
import {
  createWorkflowNode,
  toWorkflowDefinitionGraphDocument,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
} from "~/features/workflow/document";
import { SYSTEM_PROMPT_INPUT_HANDLE_ID } from "~/features/workflow/llm-models";
import { PROMPT_INPUT_HANDLE_ID } from "~/features/workflow/node-definitions";
import type { WorkflowAsset } from "~/features/workflow/types";

describe("renderTaskRunProviderInput", () => {
  test("renders provider requests from materialized prompt, system prompt, and image facts", () => {
    const node = { ...createWorkflowNode("llmGenerator", 0), id: "llm-node" };
    const image = workflowImageAsset("materialized-reference");
    const materializedInputFacts = {
      dependencyAddresses: [],
      imageInputsByHandle: { "image-input-0": [image] },
      prompt: "write from frozen facts",
      systemPrompt: "use a factual tone",
    } satisfies MaterializedProviderInputFacts;

    const result = renderTaskRunProviderInput({
      idempotencyKey: "task_run:llm-task:attempt:0",
      itemIndex: 0,
      materializedInputFacts,
      resolvedParentTaskRuns: [],
      targetNodeConfig: node,
    });

    assert.equal(result.kind, "executable");
    assert.deepEqual(result.providerInput, {
      kind: "llm-generation-request",
      request: {
        idempotencyKey: "task_run:llm-task:attempt:0",
        maxOutputTokens: 2048,
        mode: null,
        model: "gemini-3-flash-preview",
        prompt: "write from frozen facts",
        referenceImages: [image],
        systemPrompt: "use a factual tone",
        temperature: 1,
        thinkingLevel: "LOW",
      },
    });
  });

  test("renders an image generation request from target config and direct prompt parent output", () => {
    const node = {
      ...createWorkflowNode("imageGenerator", 0),
      id: "image-node",
    };

    const result = renderTaskRunProviderInput({
      idempotencyKey: "task_run:image-task:attempt:0",
      itemIndex: 0,
      resolvedParentTaskRuns: [
        textParent("make a glass castle", PROMPT_INPUT_HANDLE_ID),
      ],
      targetNodeConfig: node,
    });

    assert.deepEqual(result, {
      kind: "executable",
      providerInput: {
        kind: "image-generation-request",
        request: {
          aspectRatio: "1:1",
          idempotencyKey: "task_run:image-task:attempt:0",
          mode: "default",
          model: "gemini-3-pro-image-preview",
          prompt: "make a glass castle",
          referenceImages: [],
        },
      },
    });
  });

  test("renders an LLM generation request with prompt, system prompt, and direct media parent output", () => {
    const node = { ...createWorkflowNode("llmGenerator", 0), id: "llm-node" };
    const image = workflowImageAsset("image-asset");

    const result = renderTaskRunProviderInput({
      idempotencyKey: "task_run:llm-task:attempt:0",
      itemIndex: 0,
      resolvedParentTaskRuns: [
        textParent("write a shot list", PROMPT_INPUT_HANDLE_ID),
        textParent("answer tersely", SYSTEM_PROMPT_INPUT_HANDLE_ID),
        mediaParent(image, "image-input-0"),
      ],
      targetNodeConfig: node,
    });

    assert.equal(result.kind, "executable");
    assert.deepEqual(result.providerInput, {
      kind: "llm-generation-request",
      request: {
        idempotencyKey: "task_run:llm-task:attempt:0",
        maxOutputTokens: 2048,
        mode: null,
        model: "gemini-3-flash-preview",
        prompt: "write a shot list",
        referenceImages: [image],
        systemPrompt: "answer tersely",
        temperature: 1,
        thinkingLevel: "LOW",
      },
    });
  });

  test("renders direct image parent outputs into imageInputsByHandle for video requests", () => {
    const node = {
      ...createWorkflowNode("videoGenerator", 0),
      id: "video-node",
    };
    const image = workflowImageAsset("reference-image");

    const result = renderTaskRunProviderInput({
      idempotencyKey: "task_run:video-task:attempt:0",
      itemIndex: 0,
      resolvedParentTaskRuns: [
        textParent("animate this", PROMPT_INPUT_HANDLE_ID),
        mediaParent(image, "image-input-0"),
      ],
      targetNodeConfig: node,
    });

    assert.equal(result.kind, "executable");
    assert.deepEqual(result.providerInput.request.referenceImages, [image]);
  });

  test("renders direct and reordered image parents into first/last video frames by handle", () => {
    const imageNode = createWorkflowNode("imageGenerator", 0);
    const reorderNode = createWorkflowNode("outputReorder", 1);
    const videoNode = createWorkflowNode("videoGenerator", 2);
    if (
      imageNode.kind !== "imageGenerator" ||
      reorderNode.kind !== "outputReorder" ||
      videoNode.kind !== "videoGenerator"
    ) {
      throw new Error("Unexpected workflow node kind");
    }
    const image = { ...imageNode, id: "image" };
    const reorder = {
      ...reorderNode,
      id: "shift",
      shift: 1,
      valueType: "image" as const,
    };
    const video = {
      ...videoNode,
      id: "video",
      mode: "first-last-frame" as const,
    };
    const document = toWorkflowDefinitionGraphDocument({
      version: WORKFLOW_DOCUMENT_VERSION,
      nodes: [image, reorder, video],
      edges: [
        {
          id: "image-video-first",
          source: image.id,
          sourceHandle: "images",
          target: video.id,
          targetHandle: "first-frame",
        },
        {
          id: "image-shift",
          source: image.id,
          sourceHandle: "images",
          target: reorder.id,
          targetHandle: "input",
        },
        {
          id: "shift-video-last",
          source: reorder.id,
          sourceHandle: "output",
          target: video.id,
          targetHandle: "last-frame",
        },
      ],
    });
    const frame1 = workflowImageAsset("frame-1");
    const frame3 = workflowImageAsset("frame-3");
    const targetNodeConfig = document.nodes.find(
      (node) => node.id === video.id,
    );
    assert.equal(targetNodeConfig?.kind, "videoGenerator");

    const result = renderTaskRunProviderInput({
      idempotencyKey: "task_run:video-task:attempt:0",
      itemIndex: 2,
      resolvedParentTaskRuns: [
        mediaParent(frame1, "last-frame", image.id, 0),
        mediaParent(frame3, "first-frame", image.id, 2),
      ],
      targetNodeConfig,
      workflowDefinition: document,
    });

    assert.equal(result.kind, "executable");
    assert.equal(result.providerInput.kind, "video-generation-request");
    assert.equal(result.providerInput.request.firstFrame?.id, frame3.id);
    assert.equal(result.providerInput.request.lastFrame?.id, frame1.id);
  });

  test("preserves non-local parent Asset metadata for provider materialization", () => {
    const node = {
      ...createWorkflowNode("imageGenerator", 0),
      id: "image-node",
    };
    const image = {
      ...workflowImageAsset("external-reference-image"),
      externalUri: "gs://workflow-assets/external-reference-image.png",
      storagePath: null,
    } satisfies WorkflowAsset;

    const result = renderTaskRunProviderInput({
      idempotencyKey: "task_run:image-task:attempt:0",
      itemIndex: 0,
      resolvedParentTaskRuns: [
        textParent("use this reference", PROMPT_INPUT_HANDLE_ID),
        mediaParent(image, "image-input-0"),
      ],
      targetNodeConfig: node,
    });

    assert.equal(result.kind, "executable");
    assert.deepEqual(result.providerInput.request.referenceImages, [image]);
  });

  test("folds prompt-node variables into generator provider input from upstream Task Run outputs", () => {
    const document = promptVariableDocument();
    const targetNodeConfig = document.nodes.find(
      (node) => node.id === "script",
    );
    assert.equal(targetNodeConfig?.kind, "llmGenerator");

    const result = renderTaskRunProviderInput({
      idempotencyKey: "task_run:script-task:attempt:0",
      itemIndex: 0,
      resolvedParentTaskRuns: [
        {
          ...textParent("clockwork birds", "topic"),
          address: {
            parentItemIndex: 0,
            parentNodeId: "topic-source",
            sourceHandle: "text",
            targetHandle: "topic",
            targetNodeId: "prompt",
          },
        },
      ],
      targetNodeConfig,
      workflowDefinition: toWorkflowDefinitionGraphDocument(document),
    });

    assert.equal(result.kind, "executable");
    assert.equal(
      result.providerInput.request.prompt,
      "Describe clockwork birds",
    );
  });

  test("returns a typed non-executable result for unsupported node kinds", () => {
    const node = { ...createWorkflowNode("list", 0), id: "list-node" };

    const result = renderTaskRunProviderInput({
      idempotencyKey: "task_run:list-task:attempt:0",
      itemIndex: 0,
      resolvedParentTaskRuns: [],
      targetNodeConfig: node,
    });

    assert.deepEqual(result, {
      kind: "non-executable",
      providerInput: {
        kind: "non-executable-node",
        reason: "UNSUPPORTED_NODE_KIND",
        message: "Node kind list is not executable by the provider runtime.",
      },
    });
  });
});

function textParent(
  text: string,
  targetHandle: string,
): ResolvedParentTaskRunInputSnapshot {
  return {
    address: {
      parentItemIndex: 0,
      parentNodeId: `source-${targetHandle}`,
      sourceHandle: "text",
      targetHandle,
      targetNodeId: "target-node",
    },
    attempt: 0,
    itemIndex: 0,
    nodeExecutionId: `node-execution-${targetHandle}`,
    output: {
      assetId: `asset-${targetHandle}`,
      kind: "inline-text-asset",
      text,
    },
    taskRunId: `task-run-${targetHandle}`,
  };
}

function mediaParent(
  asset: WorkflowAsset,
  targetHandle: string,
  parentNodeId?: string,
  itemIndex = 0,
): ResolvedParentTaskRunInputSnapshot {
  return {
    address: {
      parentItemIndex: itemIndex,
      parentNodeId: parentNodeId ?? `source-${targetHandle}`,
      sourceHandle: "images",
      targetHandle,
      targetNodeId: "target-node",
    },
    attempt: 0,
    asset,
    itemIndex,
    nodeExecutionId: `node-execution-${targetHandle}`,
    output: {
      assetId: asset.id,
      cdnUrl: asset.url,
      contentType: asset.mimeType,
      kind: "cdn-asset",
    },
    taskRunId: `task-run-${targetHandle}`,
  };
}

function workflowImageAsset(id: string): WorkflowAsset {
  return {
    createdAt: "2026-04-30T00:00:00.000Z",
    externalUri: null,
    fileName: `${id}.png`,
    id,
    kind: "image",
    mimeType: "image/png",
    model: null,
    size: 1,
    source: "generated",
    storagePath: `generated/image/${id}.png`,
    url: `https://cdn.example.com/${id}.png`,
  };
}

function promptVariableDocument(): WorkflowDocument {
  const prompt = createWorkflowNode("prompt", 0);
  if (prompt.kind !== "prompt") {
    throw new Error("Expected prompt node");
  }
  return {
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes: [
      { ...createWorkflowNode("llmGenerator", 0), id: "topic-source" },
      {
        ...prompt,
        id: "prompt",
        prompt: "Describe {{topic}}",
        variables: [{ key: "topic", label: "Topic" }],
      },
      { ...createWorkflowNode("llmGenerator", 0), id: "script" },
    ],
    edges: [
      {
        id: "source-to-prompt",
        source: "topic-source",
        sourceHandle: "text",
        target: "prompt",
        targetHandle: "topic",
      },
      {
        id: "prompt-to-script",
        source: "prompt",
        sourceHandle: "text",
        target: "script",
        targetHandle: PROMPT_INPUT_HANDLE_ID,
      },
    ],
  };
}
