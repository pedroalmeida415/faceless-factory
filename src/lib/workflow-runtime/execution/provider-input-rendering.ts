import type { WorkflowDefinitionDocumentNode } from "~/lib/workflow/document";
import {
  buildImageGenerationRequest,
  buildVideoGenerationRequest,
} from "~/lib/workflow/generator-models";
import {
  buildLlmGenerationRequest,
  SYSTEM_PROMPT_INPUT_HANDLE_ID,
} from "~/lib/workflow/llm-models";
import { PROMPT_INPUT_HANDLE_ID } from "~/lib/workflow/node-definitions";
import type {
  GenerateImageRequest,
  GenerateLlmRequest,
  GenerateVideoRequest,
  WorkflowAsset,
} from "~/lib/workflow/types";
import type { ResolvedParentTaskRunInputSnapshot } from "~/lib/workflow-runtime/execution/task-run-input-snapshot";

export type RenderedTaskRunProviderInput =
  | {
      readonly kind: "image-generation-request";
      readonly request: GenerateImageRequest;
    }
  | {
      readonly kind: "video-generation-request";
      readonly request: GenerateVideoRequest;
    }
  | {
      readonly kind: "llm-generation-request";
      readonly request: GenerateLlmRequest;
    };

export type NonExecutableTaskRunProviderInput = {
  readonly kind: "non-executable-node";
  readonly reason: "UNSUPPORTED_NODE_KIND";
  readonly message: string;
};

export type TaskRunProviderInput =
  | RenderedTaskRunProviderInput
  | NonExecutableTaskRunProviderInput;

export type TaskRunProviderInputRenderingResult =
  | {
      readonly kind: "executable";
      readonly providerInput: RenderedTaskRunProviderInput;
    }
  | {
      readonly kind: "non-executable";
      readonly providerInput: NonExecutableTaskRunProviderInput;
    };

export type RenderTaskRunProviderInputCommand = {
  readonly targetNodeConfig: WorkflowDefinitionDocumentNode;
  readonly itemIndex: number;
  readonly idempotencyKey: string;
  readonly resolvedParentTaskRuns: readonly ResolvedParentTaskRunInputSnapshot[];
};

export function renderTaskRunProviderInput(
  command: RenderTaskRunProviderInputCommand,
): TaskRunProviderInputRenderingResult {
  const prompt = renderPrompt(command.resolvedParentTaskRuns);
  const systemPrompt = renderSystemPrompt(command.resolvedParentTaskRuns);
  const imageInputsByHandle = renderImageInputsByHandle(
    command.resolvedParentTaskRuns,
  );
  void command.itemIndex;

  switch (command.targetNodeConfig.kind) {
    case "imageGenerator":
      return {
        kind: "executable",
        providerInput: {
          kind: "image-generation-request",
          request: buildImageGenerationRequest({
            idempotencyKey: command.idempotencyKey,
            imageInputsByHandle,
            prompt,
            settings: command.targetNodeConfig,
          }),
        },
      };
    case "videoGenerator":
      return {
        kind: "executable",
        providerInput: {
          kind: "video-generation-request",
          request: buildVideoGenerationRequest({
            idempotencyKey: command.idempotencyKey,
            imageInputsByHandle,
            prompt,
            settings: command.targetNodeConfig,
          }),
        },
      };
    case "llmGenerator":
      return {
        kind: "executable",
        providerInput: {
          kind: "llm-generation-request",
          request: buildLlmGenerationRequest({
            idempotencyKey: command.idempotencyKey,
            imageInputsByHandle,
            prompt,
            settings: command.targetNodeConfig,
            systemPrompt,
          }),
        },
      };
    case "asset":
    case "list":
    case "outputReorder":
    case "prompt":
      return {
        kind: "non-executable",
        providerInput: {
          kind: "non-executable-node",
          message: `Node kind ${command.targetNodeConfig.kind} is not executable by the provider runtime.`,
          reason: "UNSUPPORTED_NODE_KIND",
        },
      };
  }
}

export function isRenderedTaskRunProviderInput(
  value: TaskRunProviderInput,
): value is RenderedTaskRunProviderInput {
  return value.kind !== "non-executable-node";
}

function renderPrompt(
  parents: readonly ResolvedParentTaskRunInputSnapshot[],
): string {
  return joinTextOutputs(
    parents.filter((parent) => isPromptHandle(parent.targetHandle)),
  );
}

function renderSystemPrompt(
  parents: readonly ResolvedParentTaskRunInputSnapshot[],
): string | null {
  const text = joinTextOutputs(
    parents.filter((parent) => isSystemPromptHandle(parent.targetHandle)),
  );

  return text.length ? text : null;
}

function joinTextOutputs(
  parents: readonly ResolvedParentTaskRunInputSnapshot[],
) {
  return parents
    .flatMap((parent) =>
      parent.output?.kind === "inline-text-asset" ? [parent.output.text] : [],
    )
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function renderImageInputsByHandle(
  parents: readonly ResolvedParentTaskRunInputSnapshot[],
): Record<string, WorkflowAsset[]> {
  const imageInputsByHandle: Record<string, WorkflowAsset[]> = {};

  for (const parent of parents) {
    const targetHandle = parent.targetHandle;
    const asset = renderWorkflowImageAsset(parent);
    if (!targetHandle || !asset) {
      continue;
    }

    imageInputsByHandle[targetHandle] = [
      ...(imageInputsByHandle[targetHandle] ?? []),
      asset,
    ];
  }

  return imageInputsByHandle;
}

function renderWorkflowImageAsset(
  parent: ResolvedParentTaskRunInputSnapshot,
): WorkflowAsset | null {
  const output = parent.output;
  if (!output || output.kind !== "cdn-asset") {
    return null;
  }
  if (!output.contentType.startsWith("image/")) {
    return null;
  }

  return {
    createdAt: "",
    externalUri: null,
    fileName: output.assetId,
    id: output.assetId,
    kind: "image",
    mimeType: output.contentType,
    model: null,
    size: 0,
    source: "generated",
    storagePath: null,
    url: output.cdnUrl,
  };
}

function isPromptHandle(handle: string | null | undefined) {
  return handle === PROMPT_INPUT_HANDLE_ID || handle === null || !handle;
}

function isSystemPromptHandle(handle: string | null | undefined) {
  return handle === SYSTEM_PROMPT_INPUT_HANDLE_ID;
}
