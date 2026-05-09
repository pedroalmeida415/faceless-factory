import { providerDependencyMatches } from "~/features/runtime/domain/provider-dependency-address";
import type { ResolvedParentTaskInputSnapshot } from "~/features/runtime/execution/task-input-snapshot";
import type { MaterializedProviderInputFacts } from "~/features/runtime/materialization/task-input-materialization";
import type {
  WorkflowDefinitionDocumentNode,
  WorkflowDefinitionGraphDocument,
} from "~/features/workflow/document";
import {
  buildImageGenerationRequest,
  buildVideoGenerationRequest,
  getImageGeneratorHandleDefinitions,
  getVideoGeneratorHandleDefinitions,
} from "~/features/workflow/generator-models";
import {
  buildIncomingByTarget,
  buildTextRuntimeValue,
  getIncomingEdgesForHandle,
  getPromptNodeReferencedVariableKeys,
} from "~/features/workflow/graph";
import {
  buildLlmGenerationRequest,
  getLlmGeneratorHandleDefinitions,
  SYSTEM_PROMPT_INPUT_HANDLE_ID,
} from "~/features/workflow/llm-models";
import {
  OUTPUT_REORDER_INPUT_HANDLE_ID,
  PROMPT_INPUT_HANDLE_ID,
  PROMPT_VARIABLE_PATTERN,
} from "~/features/workflow/node-definitions";
import {
  getBroadcastOutput,
  type RuntimeValue,
  reorderRuntimeValue,
  resolveOutputPermutation,
} from "~/features/workflow/runtime-values";
import type {
  GenerateImageRequest,
  GenerateLlmRequest,
  GenerateVideoRequest,
  WorkflowAsset,
} from "~/features/workflow/types";

export type RenderedTaskProviderInput =
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

export type NonExecutableTaskProviderInput = {
  readonly kind: "non-executable-node";
  readonly reason: "UNSUPPORTED_NODE_KIND";
  readonly message: string;
};

export type TaskProviderInput =
  | RenderedTaskProviderInput
  | NonExecutableTaskProviderInput;

export type TaskProviderInputRenderingResult =
  | {
      readonly kind: "executable";
      readonly providerInput: RenderedTaskProviderInput;
    }
  | {
      readonly kind: "non-executable";
      readonly providerInput: NonExecutableTaskProviderInput;
    };

export type RenderTaskProviderInputCommand = {
  readonly targetNodeConfig: WorkflowDefinitionDocumentNode;
  readonly branchIndex: number;
  readonly idempotencyKey: string;
  readonly materializedInputFacts?: MaterializedProviderInputFacts;
  readonly resolvedParentTasks: readonly ResolvedParentTaskInputSnapshot[];
  readonly workflowDefinition?: WorkflowDefinitionGraphDocument;
};

export function renderTaskProviderInput(
  command: RenderTaskProviderInputCommand,
): TaskProviderInputRenderingResult {
  const prompt = command.materializedInputFacts
    ? joinTextValues([
        command.materializedInputFacts.prompt,
        renderPrompt(command.resolvedParentTasks),
      ])
    : command.workflowDefinition
      ? renderTextInput(command, PROMPT_INPUT_HANDLE_ID)
      : renderPrompt(command.resolvedParentTasks);
  const systemPrompt = command.materializedInputFacts
    ? joinTextValues([
        command.materializedInputFacts.systemPrompt ?? "",
        renderSystemPrompt(command.resolvedParentTasks) ?? "",
      ]) || null
    : command.workflowDefinition
      ? renderTextInput(command, SYSTEM_PROMPT_INPUT_HANDLE_ID) || null
      : renderSystemPrompt(command.resolvedParentTasks);
  const imageInputsByHandle = command.materializedInputFacts
    ? mergeImageInputsByHandle(
        command.materializedInputFacts.imageInputsByHandle,
        renderImageInputsByHandle(command.resolvedParentTasks),
      )
    : command.workflowDefinition
      ? renderWorkflowImageInputsByHandle(command)
      : renderImageInputsByHandle(command.resolvedParentTasks);

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

function joinTextValues(values: readonly string[]) {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n\n");
}

function mergeImageInputsByHandle(
  left: Readonly<Record<string, readonly WorkflowAsset[]>>,
  right: Readonly<Record<string, readonly WorkflowAsset[]>>,
) {
  const result: Record<string, WorkflowAsset[]> = {};
  for (const [handleId, assets] of [
    ...Object.entries(left),
    ...Object.entries(right),
  ]) {
    if (assets.length) {
      result[handleId] = [...(result[handleId] ?? []), ...assets];
    }
  }
  return result;
}

export function isRenderedTaskProviderInput(
  value: TaskProviderInput,
): value is RenderedTaskProviderInput {
  return value.kind !== "non-executable-node";
}

function renderPrompt(
  parents: readonly ResolvedParentTaskInputSnapshot[],
): string {
  return joinTextOutputs(
    parents.filter((parent) => isPromptHandle(parent.address.targetHandle)),
  );
}

function renderSystemPrompt(
  parents: readonly ResolvedParentTaskInputSnapshot[],
): string | null {
  const text = joinTextOutputs(
    parents.filter((parent) =>
      isSystemPromptHandle(parent.address.targetHandle),
    ),
  );

  return text.length ? text : null;
}

function joinTextOutputs(parents: readonly ResolvedParentTaskInputSnapshot[]) {
  return parents
    .flatMap((parent) =>
      parent.output?.kind === "inline-text-asset" ? [parent.output.text] : [],
    )
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function renderTextInput(
  command: RenderTaskProviderInputCommand,
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
      ? (renderSystemPrompt(command.resolvedParentTasks) ?? "")
      : renderPrompt(command.resolvedParentTasks);
  }

  const values = incomingEdges.flatMap((edge) => {
    const value = resolveWorkflowNodeRuntimeValue({
      command,
      incomingByTarget,
      nodeId: edge.source,
      path: new Set(),
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      workflowDefinition,
    });
    return value?.type === "text" ? [value] : [];
  });
  const value = buildTextRuntimeValue(values);
  return value
    ? (getBroadcastOutput(value.items, command.branchIndex) ?? "")
    : "";
}

function renderWorkflowImageInputsByHandle(
  command: RenderTaskProviderInputCommand,
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
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        workflowDefinition,
      });
      if (value?.type !== "image") {
        return [];
      }

      return getBroadcastOutput(value.items, command.branchIndex) ?? [];
    });

    if (assets.length) {
      imageInputsByHandle[handle.id] = assets;
    }
  }

  return imageInputsByHandle;
}

function getTargetGeneratorInputHandles(
  command: RenderTaskProviderInputCommand,
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
  readonly command: RenderTaskProviderInputCommand;
  readonly incomingByTarget: ReturnType<typeof buildIncomingByTarget>;
  readonly nodeId: string;
  readonly path: ReadonlySet<string>;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
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
        sourceHandle: inputEdge.sourceHandle,
        targetHandle: input.targetHandle,
      });
      if (
        value &&
        input.command.resolvedParentTasks.some((parent) =>
          providerDependencyMatches(parent.address, {
            parentNodeId: inputEdge.source,
            sourceHandle: inputEdge.sourceHandle,
          }),
        ) &&
        value.items.length < node.order.length
      ) {
        return value;
      }
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
      return resolveParentTaskRuntimeValue({
        command: input.command,
        nodeId: node.id,
        sourceHandle: input.sourceHandle,
        targetHandle: input.targetHandle,
      });
  }
}

function resolvePromptRuntimeValue(input: {
  readonly command: RenderTaskProviderInputCommand;
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
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
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

function resolveParentTaskRuntimeValue(input: {
  readonly command: RenderTaskProviderInputCommand;
  readonly nodeId: string;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
}): RuntimeValue | null {
  const parents = input.command.resolvedParentTasks.filter((parent) => {
    return providerDependencyMatches(parent.address, {
      parentNodeId: input.nodeId,
      sourceHandle: input.sourceHandle,
      targetHandle: input.targetHandle,
    });
  });
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
  parents: readonly ResolvedParentTaskInputSnapshot[],
): Record<string, WorkflowAsset[]> {
  const imageInputsByHandle: Record<string, WorkflowAsset[]> = {};

  for (const parent of parents) {
    const targetHandle = parent.address.targetHandle;
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
  parent: ResolvedParentTaskInputSnapshot,
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
