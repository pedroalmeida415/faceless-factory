import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createWorkflowNode } from "~/lib/workflow/document";
import { SYSTEM_PROMPT_INPUT_HANDLE_ID } from "~/lib/workflow/llm-models";
import { PROMPT_INPUT_HANDLE_ID } from "~/lib/workflow/node-definitions";
import type { WorkflowAsset } from "~/lib/workflow/types";
import { renderTaskRunProviderInput } from "~/lib/workflow-runtime/execution/provider-input-rendering";
import type { ResolvedParentTaskRunInputSnapshot } from "~/lib/workflow-runtime/execution/task-run-input-snapshot";

describe("renderTaskRunProviderInput", () => {
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
    const renderedImage = renderedWorkflowImageAsset("image-asset");

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
        referenceImages: [renderedImage],
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
    const renderedImage = renderedWorkflowImageAsset("reference-image");

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
    assert.deepEqual(result.providerInput.request.referenceImages, [
      renderedImage,
    ]);
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
    attempt: 0,
    itemIndex: 0,
    nodeExecutionId: `node-execution-${targetHandle}`,
    output: {
      assetId: `asset-${targetHandle}`,
      kind: "inline-text-asset",
      text,
    },
    sourceHandle: "text",
    targetHandle,
    taskRunId: `task-run-${targetHandle}`,
  };
}

function mediaParent(
  asset: WorkflowAsset,
  targetHandle: string,
): ResolvedParentTaskRunInputSnapshot {
  return {
    attempt: 0,
    itemIndex: 0,
    nodeExecutionId: `node-execution-${targetHandle}`,
    output: {
      assetId: asset.id,
      cdnUrl: asset.url,
      contentType: asset.mimeType,
      kind: "cdn-asset",
    },
    sourceHandle: "images",
    targetHandle,
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
    storagePath: null,
    url: `https://cdn.example.com/${id}.png`,
  };
}

function renderedWorkflowImageAsset(id: string): WorkflowAsset {
  return {
    ...workflowImageAsset(id),
    createdAt: "",
    fileName: id,
    size: 0,
  };
}
