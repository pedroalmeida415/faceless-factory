import type {
  WorkflowDefinitionDocumentNode,
  WorkflowDefinitionGraphDocument,
} from "~/lib/workflow/document";
import {
  buildImageGenerationRequest,
  buildVideoGenerationRequest,
  getImageGeneratorHandleDefinitions,
  getVideoGeneratorHandleDefinitions,
} from "~/lib/workflow/generator-models";
import {
  buildIncomingByTarget,
  buildTextRuntimeValue,
  getIncomingEdgesForHandle,
  getPromptNodeReferencedVariableKeys,
} from "~/lib/workflow/graph";
import {
  buildLlmGenerationRequest,
  getLlmGeneratorHandleDefinitions,
  SYSTEM_PROMPT_INPUT_HANDLE_ID,
} from "~/lib/workflow/llm-models";
import {
  OUTPUT_REORDER_INPUT_HANDLE_ID,
  PROMPT_INPUT_HANDLE_ID,
  PROMPT_VARIABLE_PATTERN,
} from "~/lib/workflow/node-definitions";
import {
  getBroadcastOutput,
  type RuntimeValue,
  reorderRuntimeValue,
  resolveOutputPermutation,
} from "~/lib/workflow/runtime-values";
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
  readonly workflowDefinition?: WorkflowDefinitionGraphDocument;
};

export function renderTaskRunProviderInput(
  command: RenderTaskRunProviderInputCommand,
): TaskRunProviderInputRenderingResult {
  const prompt = command.workflowDefinition
    ? renderTextInput(command, PROMPT_INPUT_HANDLE_ID)
    : renderPrompt(command.resolvedParentTaskRuns);
  const systemPrompt = command.workflowDefinition
    ? renderTextInput(command, SYSTEM_PROMPT_INPUT_HANDLE_ID) || null
    : renderSystemPrompt(command.resolvedParentTaskRuns);
  const imageInputsByHandle = command.workflowDefinition
    ? renderWorkflowImageInputsByHandle(command)
    : renderImageInputsByHandle(command.resolvedParentTaskRuns);

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

function renderTextInput(
  command: RenderTaskRunProviderInputCommand,
  handleId: string,
) {
  const workflowDefinition = command.workflowDefinition;
  if (!workflowDefinition) {
    return "";
  }

  const incomingByTarget = buildIncomingByTarget(workflowDefinition.edges);
  const incomingEdges = getIncomingEdgesForHandle(
    incomingByTarget,
    command.targetNodeConfig.id,
    handleId,
  );
  if (!incomingEdges.length) {
    return handleId === SYSTEM_PROMPT_INPUT_HANDLE_ID
      ? (renderSystemPrompt(command.resolvedParentTaskRuns) ?? "")
      : renderPrompt(command.resolvedParentTaskRuns);
  }

  const values = incomingEdges.flatMap((edge) => {
    const value = resolveWorkflowNodeRuntimeValue({
      command,
      incomingByTarget,
      nodeId: edge.source,
      path: new Set(),
      workflowDefinition,
    });
    return value?.type === "text" ? [value] : [];
  });
  const value = buildTextRuntimeValue(values);
  return value
    ? (getBroadcastOutput(value.items, command.itemIndex) ?? "")
    : "";
}

function renderWorkflowImageInputsByHandle(
  command: RenderTaskRunProviderInputCommand,
): Record<string, WorkflowAsset[]> {
  const workflowDefinition = command.workflowDefinition;
  if (!workflowDefinition) {
    return {};
  }

  const incomingByTarget = buildIncomingByTarget(workflowDefinition.edges);
  const imageInputsByHandle: Record<string, WorkflowAsset[]> = {};
  for (const handle of getTargetGeneratorInputHandles(command)) {
    if (handle.valueType !== "image") {
      continue;
    }

    const assets = getIncomingEdgesForHandle(
      incomingByTarget,
      command.targetNodeConfig.id,
      handle.id,
    ).flatMap((edge) => {
      const value = resolveWorkflowNodeRuntimeValue({
        command,
        incomingByTarget,
        nodeId: edge.source,
        path: new Set(),
        workflowDefinition,
      });
      if (value?.type !== "image") {
        return [];
      }

      return getBroadcastOutput(value.items, command.itemIndex) ?? [];
    });

    if (assets.length) {
      imageInputsByHandle[handle.id] = assets;
    }
  }

  return imageInputsByHandle;
}

function getTargetGeneratorInputHandles(
  command: RenderTaskRunProviderInputCommand,
) {
  const edges = command.workflowDefinition?.edges ?? [];
  switch (command.targetNodeConfig.kind) {
    case "imageGenerator":
      return getImageGeneratorHandleDefinitions(
        command.targetNodeConfig,
        edges,
        command.targetNodeConfig.id,
      );
    case "videoGenerator":
      return getVideoGeneratorHandleDefinitions(
        command.targetNodeConfig,
        edges,
        command.targetNodeConfig.id,
      );
    case "llmGenerator":
      return getLlmGeneratorHandleDefinitions(
        command.targetNodeConfig,
        edges,
        command.targetNodeConfig.id,
      );
    default:
      return [];
  }
}

function resolveWorkflowNodeRuntimeValue(input: {
  readonly command: RenderTaskRunProviderInputCommand;
  readonly incomingByTarget: ReturnType<typeof buildIncomingByTarget>;
  readonly nodeId: string;
  readonly path: ReadonlySet<string>;
  readonly workflowDefinition: WorkflowDefinitionGraphDocument;
}): RuntimeValue | null {
  if (input.path.has(input.nodeId)) {
    return null;
  }

  const node = input.workflowDefinition.nodes.find(
    (candidate) => candidate.id === input.nodeId,
  );
  if (!node) {
    return null;
  }

  const nextPath = new Set(input.path);
  nextPath.add(input.nodeId);

  switch (node.kind) {
    case "list": {
      const items = node.items.map((item) => item.trim()).filter(Boolean);
      return items.length ? { items, type: "text" } : null;
    }
    case "asset":
      return node.assetKind && node.assets.length
        ? { items: node.assets.map((asset) => [asset]), type: node.assetKind }
        : null;
    case "prompt":
      return resolvePromptRuntimeValue({ ...input, node, path: nextPath });
    case "outputReorder": {
      const inputEdge = getIncomingEdgesForHandle(
        input.incomingByTarget,
        node.id,
        OUTPUT_REORDER_INPUT_HANDLE_ID,
      )[0];
      if (!inputEdge) {
        return null;
      }
      const value = resolveWorkflowNodeRuntimeValue({
        ...input,
        nodeId: inputEdge.source,
        path: nextPath,
      });
      return value && value.type === node.valueType
        ? reorderRuntimeValue(
            value,
            resolveOutputPermutation({
              mode: node.mode,
              order: node.order,
              outputCount: value.items.length,
              shift: node.shift,
            }),
          )
        : null;
    }
    case "imageGenerator":
    case "videoGenerator":
    case "llmGenerator":
      return resolveParentTaskRunRuntimeValue(input.command, node.id);
  }
}

function resolvePromptRuntimeValue(input: {
  readonly command: RenderTaskRunProviderInputCommand;
  readonly incomingByTarget: ReturnType<typeof buildIncomingByTarget>;
  readonly node: Extract<WorkflowDefinitionDocumentNode, { kind: "prompt" }>;
  readonly nodeId: string;
  readonly path: ReadonlySet<string>;
  readonly workflowDefinition: WorkflowDefinitionGraphDocument;
}): RuntimeValue | null {
  const variableKeys = getPromptNodeReferencedVariableKeys(input.node);
  const resolvedVariables = variableKeys.flatMap((key) => {
    const values = getIncomingEdgesForHandle(
      input.incomingByTarget,
      input.node.id,
      key,
    ).flatMap((edge) => {
      const value = resolveWorkflowNodeRuntimeValue({
        ...input,
        nodeId: edge.source,
      });
      return value?.type === "text" ? [value] : [];
    });
    const value = buildTextRuntimeValue(values);
    return value ? [[key, value.items] as const] : [];
  });
  const outputCount = Math.max(
    1,
    ...resolvedVariables.map(([, items]) => items.length),
  );
  const variableKeysSet = new Set(
    input.node.variables.map((variable) => variable.key),
  );
  const prompts = Array.from({ length: outputCount }, (_, index) => {
    const prompt = input.node.prompt.replace(
      PROMPT_VARIABLE_PATTERN,
      (match, key: string) => {
        if (!variableKeysSet.has(key)) {
          return match;
        }
        const items = resolvedVariables.find(
          ([candidate]) => candidate === key,
        )?.[1];
        return items ? (getBroadcastOutput(items, index) ?? "") : "";
      },
    );
    return prompt.trim();
  }).filter(Boolean);

  return prompts.length ? { items: prompts, type: "text" } : null;
}

function resolveParentTaskRunRuntimeValue(
  command: RenderTaskRunProviderInputCommand,
  nodeId: string,
): RuntimeValue | null {
  const parents = command.resolvedParentTaskRuns.filter(
    (parent) => parent.sourceNodeId === nodeId,
  );
  const textItems = parents.flatMap((parent) =>
    parent.output?.kind === "inline-text-asset" ? [parent.output.text] : [],
  );
  if (textItems.length) {
    return { items: textItems, type: "text" };
  }

  const mediaItems = parents.flatMap((parent) => {
    const output = parent.output;
    if (!output || output.kind !== "cdn-asset") {
      return [];
    }
    const asset = renderWorkflowImageAsset(parent);
    return asset ? [[asset]] : [];
  });

  return mediaItems.length ? { items: mediaItems, type: "image" } : null;
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
  if (parent.asset?.kind === "image") {
    return parent.asset;
  }

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
