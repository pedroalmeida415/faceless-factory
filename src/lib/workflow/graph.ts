import type { Connection, HandleType } from "reactflow";

import type {
  PromptWorkflowNode,
  WorkflowDocument,
  WorkflowDocumentEdge,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { getRuntimeValueOutput } from "~/lib/workflow/execution/node-outputs";
import {
  type GeneratorHandleDefinition,
  getImageGeneratorHandleDefinitions,
  getVideoGeneratorHandleDefinitions,
} from "~/lib/workflow/generator-models";
import { getLlmGeneratorHandleDefinitions } from "~/lib/workflow/llm-models";
import {
  getNodeOutputHandleId,
  getOutputSplitOutputHandleId,
  OUTPUT_REORDER_INPUT_HANDLE_ID,
  OUTPUT_REORDER_OUTPUT_HANDLE_ID,
  OUTPUT_TRANSFORM_INPUT_HANDLE_ID,
  OUTPUT_TRANSFORM_OUTPUT_HANDLE_ID,
  PROMPT_VARIABLE_HANDLE_COLOR,
  PROMPT_VARIABLE_PATTERN,
  type WorkflowValueType,
} from "~/lib/workflow/node-definitions";
import {
  getApprovedReviewOutputRuntimeValue,
  getApprovedReviewRuntimeValue,
} from "~/lib/workflow/review-state";
import {
  type MediaRuntimeValue,
  mergeRuntimeValues,
  type RuntimeValue,
  reorderRuntimeValue,
  resolveOutputPermutation,
  selectRuntimeValue,
  splitRuntimeValueOutput,
  type TextRuntimeValue,
  zipAlignRuntimeValues,
} from "~/lib/workflow/runtime-values";
import { isGeneratorNodeKind, type WorkflowAsset } from "~/lib/workflow/types";

export type { MediaRuntimeValue, RuntimeValue, TextRuntimeValue };

export type WorkflowHandleReference = {
  nodeId: string;
  handleId: string | null;
  handleType: HandleType;
};

type NodeMap = Map<string, WorkflowDocumentNode>;
type IncomingByTarget = Map<string, WorkflowDocumentEdge[]>;

type MediaBatchPlan = {
  batches: WorkflowAsset[][];
  iterations: number;
};

type TextBatchPlan = {
  items: string[];
  iterations: number;
};

export type GeneratorAssetBatchPlan = {
  batches: Record<string, WorkflowAsset[]>[];
  iterations: number;
};

export type GeneratorExecutionBatch = {
  mediaInputsByHandle: Record<string, WorkflowAsset[]>;
  prompt: string;
  systemPrompt: string | null;
};

export type GeneratorExecutionBatchPlan = {
  batches: GeneratorExecutionBatch[];
  hasIterator: boolean;
  iterations: number;
};

function toNodeMap(document: WorkflowDocument) {
  return new Map(document.nodes.map((node) => [node.id, node]));
}

export function buildIncomingByTarget(edges: WorkflowDocumentEdge[]) {
  const incomingByTarget = new Map<string, WorkflowDocumentEdge[]>();

  for (const edge of edges) {
    const existing = incomingByTarget.get(edge.target) ?? [];
    existing.push(edge);
    incomingByTarget.set(edge.target, existing);
  }

  return incomingByTarget;
}

export function buildOutgoingBySource(edges: WorkflowDocumentEdge[]) {
  const outgoingBySource = new Map<string, WorkflowDocumentEdge[]>();

  for (const edge of edges) {
    const existing = outgoingBySource.get(edge.source) ?? [];
    existing.push(edge);
    outgoingBySource.set(edge.source, existing);
  }

  return outgoingBySource;
}

export function getIncomingEdgesForHandle(
  incomingByTarget: Map<string, WorkflowDocumentEdge[]>,
  targetId: string,
  handleId: string,
) {
  return (incomingByTarget.get(targetId) ?? []).filter(
    (edge) => edge.targetHandle === handleId,
  );
}

function getGeneratorHandleDefinitions(
  node: WorkflowDocumentNode,
  edges: WorkflowDocumentEdge[],
): GeneratorHandleDefinition[] {
  switch (node.kind) {
    case "imageGenerator":
      return getImageGeneratorHandleDefinitions(node, edges, node.id);
    case "videoGenerator":
      return getVideoGeneratorHandleDefinitions(node, edges, node.id);
    case "llmGenerator":
      return getLlmGeneratorHandleDefinitions(node, edges, node.id);
    default:
      return [];
  }
}

function getPromptHandleDefinitions(node: PromptWorkflowNode) {
  return node.variables.map((variable, index) => ({
    color: PROMPT_VARIABLE_HANDLE_COLOR,
    id: variable.key,
    label: "Variable",
    labelIndex: index + 1,
    valueType: "text" as const,
  }));
}

function getPromptVariableKeys(node: PromptWorkflowNode) {
  return new Set(node.variables.map((variable) => variable.key));
}

function normalizeTextValues(values: readonly string[]) {
  return values.map((value) => value.trim()).filter(Boolean);
}

function joinTextValues(values: readonly string[]) {
  return normalizeTextValues(values).join("\n\n").trim();
}

export function getAlignedOutputCount(counts: readonly number[]) {
  const outputCounts = counts.filter((count) => count > 0);
  if (!outputCounts.length) {
    return 1;
  }

  const outputCount = Math.max(...outputCounts);
  const mismatchedCount = outputCounts.find(
    (count) => count !== 1 && count !== outputCount,
  );

  if (mismatchedCount !== undefined) {
    throw new Error("Connected input output item counts do not match.");
  }

  return outputCount;
}

function getBroadcastOutput<T>(items: readonly T[], index: number) {
  return items.length === 1 ? items[0] : items[index];
}

function toTextRuntimeValue(
  values: readonly string[],
): TextRuntimeValue | null {
  const normalizedValues = normalizeTextValues(values);

  return normalizedValues.length
    ? {
        type: "text",
        items: normalizedValues,
      }
    : null;
}

export function buildTextBatchPlan(
  values: readonly TextRuntimeValue[],
): TextBatchPlan {
  const outputGroups = values.map((value) => normalizeTextValues(value.items));

  if (!outputGroups.length) {
    return {
      items: [],
      iterations: 1,
    };
  }

  for (const outputs of outputGroups) {
    if (!outputs.length) {
      throw new Error("Connected text batch is empty.");
    }
  }

  const outputCount = getAlignedOutputCount(
    outputGroups.map((outputs) => outputs.length),
  );
  const resolvedOutputs = Array.from({ length: outputCount }, (_, index) =>
    joinTextValues(
      outputGroups.flatMap(
        (outputs) => getBroadcastOutput(outputs, index) ?? [],
      ),
    ),
  ).filter(Boolean);

  if (!resolvedOutputs.length) {
    throw new Error("Connected text batch is empty.");
  }

  return {
    items: resolvedOutputs,
    iterations: resolvedOutputs.length,
  };
}

export function buildTextRuntimeValue(
  values: readonly TextRuntimeValue[],
): TextRuntimeValue | null {
  const plan = buildTextBatchPlan(values);
  return toTextRuntimeValue(plan.items);
}

export function getPromptNodeReferencedVariableKeys(node: PromptWorkflowNode) {
  const variableKeys = getPromptVariableKeys(node);
  const referencedKeys = new Set<string>();

  node.prompt.replace(PROMPT_VARIABLE_PATTERN, (match, key) => {
    if (variableKeys.has(key)) {
      referencedKeys.add(key);
    }

    return match;
  });

  return Array.from(referencedKeys);
}

export function resolvePromptNodeText(
  node: PromptWorkflowNode,
  resolveVariableValue: (key: string) => string | null,
): string | null {
  const variableKeys = getPromptVariableKeys(node);
  const resolvedByKey = new Map<string, string>();
  const prompt = node.prompt.replace(PROMPT_VARIABLE_PATTERN, (match, key) => {
    if (!variableKeys.has(key)) {
      return match;
    }

    let value = resolvedByKey.get(key);
    if (value === undefined) {
      value = resolveVariableValue(key) ?? "";
      resolvedByKey.set(key, value);
    }

    return value;
  });
  const resolvedPrompt = prompt.trim();

  return resolvedPrompt ? resolvedPrompt : null;
}

export function resolvePromptNodeTextBatch(
  node: PromptWorkflowNode,
  resolveVariableValue: (key: string) => TextRuntimeValue | null,
): TextRuntimeValue | null {
  const variableKeys = getPromptVariableKeys(node);
  const referencedKeys = getPromptNodeReferencedVariableKeys(node);
  const resolvedByKey = new Map<string, TextRuntimeValue | null>();

  for (const key of referencedKeys) {
    resolvedByKey.set(key, resolveVariableValue(key));
  }

  const outputEntries = Array.from(resolvedByKey.entries()).flatMap(
    ([key, value]) => {
      if (!value) {
        return [];
      }

      const outputs = normalizeTextValues(value.items);
      if (!outputs.length) {
        return null;
      }

      return [[key, outputs] as const];
    },
  );
  if (outputEntries.some((entry) => entry === null)) {
    return null;
  }

  const textOutputEntries = outputEntries.filter(
    (entry): entry is readonly [string, string[]] => entry !== null,
  );
  const outputCount = getAlignedOutputCount(
    textOutputEntries.map(([, outputs]) => outputs.length),
  );
  const resolvedPrompts = Array.from({ length: outputCount }, (_, index) => {
    const prompt = node.prompt.replace(
      PROMPT_VARIABLE_PATTERN,
      (match, key) => {
        if (!variableKeys.has(key)) {
          return match;
        }

        const outputs = textOutputEntries.find(
          ([entryKey]) => entryKey === key,
        )?.[1];
        return outputs ? (getBroadcastOutput(outputs, index) ?? "") : "";
      },
    );
    const resolvedPrompt = prompt.trim();

    return resolvedPrompt;
  }).filter(Boolean);

  return toTextRuntimeValue(resolvedPrompts);
}

function resolveTextHandleValue(
  document: WorkflowDocument,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
  targetId: string,
  handleId: string,
  path: ReadonlySet<string>,
): TextRuntimeValue | null {
  const textValues = getIncomingEdgesForHandle(
    incomingByTarget,
    targetId,
    handleId,
  ).flatMap((edge) => {
    const runtimeValue = getWorkflowNodeRuntimeValue(
      document,
      edge.source,
      new Set(path),
      nodeMap,
      incomingByTarget,
      edge.sourceHandle,
    );

    return runtimeValue?.type === "text" ? [runtimeValue] : [];
  });

  return buildTextRuntimeValue(textValues);
}

function resolveRuntimePromptNodeText(
  document: WorkflowDocument,
  node: PromptWorkflowNode,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
): TextRuntimeValue | null {
  return resolvePromptNodeTextBatch(node, (key) =>
    resolveTextHandleValue(
      document,
      nodeMap,
      incomingByTarget,
      node.id,
      key,
      path,
    ),
  );
}

export function getOutputReorderInputValue(
  document: WorkflowDocument,
  nodeId: string,
  path: ReadonlySet<string> = new Set(),
  nodeMap = toNodeMap(document),
  incomingByTarget = buildIncomingByTarget(document.edges),
): RuntimeValue | null {
  const incomingEdges = getIncomingEdgesForHandle(
    incomingByTarget,
    nodeId,
    OUTPUT_REORDER_INPUT_HANDLE_ID,
  );
  const edge = incomingEdges[0];
  if (!edge || incomingEdges.length !== 1) {
    return null;
  }

  return getWorkflowNodeRuntimeValue(
    document,
    edge.source,
    new Set(path),
    nodeMap,
    incomingByTarget,
    edge.sourceHandle,
  );
}

export function getOutputTransformInputValue(
  document: WorkflowDocument,
  nodeId: string,
  path: ReadonlySet<string> = new Set(),
  nodeMap = toNodeMap(document),
  incomingByTarget = buildIncomingByTarget(document.edges),
): RuntimeValue | null {
  const incomingEdges = getIncomingEdgesForHandle(
    incomingByTarget,
    nodeId,
    OUTPUT_TRANSFORM_INPUT_HANDLE_ID,
  );
  const edge = incomingEdges[0];
  if (!edge || incomingEdges.length !== 1) {
    return null;
  }

  return getWorkflowNodeRuntimeValue(
    document,
    edge.source,
    new Set(path),
    nodeMap,
    incomingByTarget,
    edge.sourceHandle,
  );
}

function getOutputTransformInputValues(
  document: WorkflowDocument,
  nodeId: string,
  handleId: string,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
) {
  return getIncomingEdgesForHandle(incomingByTarget, nodeId, handleId).flatMap(
    (edge) => {
      const value = getWorkflowNodeRuntimeValue(
        document,
        edge.source,
        new Set(path),
        nodeMap,
        incomingByTarget,
        edge.sourceHandle,
      );
      return value ? [value] : [];
    },
  );
}

function resolveOutputReorderRuntimeValue(
  document: WorkflowDocument,
  node: Extract<WorkflowDocumentNode, { kind: "outputReorder" }>,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
): RuntimeValue | null {
  const inputValue = getOutputReorderInputValue(
    document,
    node.id,
    path,
    nodeMap,
    incomingByTarget,
  );
  if (!inputValue || inputValue.type !== node.valueType) {
    return null;
  }

  return reorderRuntimeValue(
    inputValue,
    resolveOutputPermutation({
      outputCount: inputValue.items.length,
      mode: node.mode,
      order: node.order,
      shift: node.shift,
    }),
  );
}

function resolveOutputSelectRuntimeValue(
  document: WorkflowDocument,
  node: Extract<WorkflowDocumentNode, { kind: "outputSelect" }>,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
): RuntimeValue | null {
  const inputValue = getOutputTransformInputValue(
    document,
    node.id,
    path,
    nodeMap,
    incomingByTarget,
  );
  return inputValue && inputValue.type === node.valueType
    ? selectRuntimeValue(inputValue, node.indices)
    : null;
}

function resolveOutputSplitRuntimeValue(
  document: WorkflowDocument,
  node: Extract<WorkflowDocumentNode, { kind: "outputSplit" }>,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
  sourceHandleId: string | null | undefined,
): RuntimeValue | null {
  const inputValue = getOutputTransformInputValue(
    document,
    node.id,
    path,
    nodeMap,
    incomingByTarget,
  );
  if (!inputValue || inputValue.type !== node.valueType) {
    return null;
  }

  const index = Number(
    (sourceHandleId ?? getOutputSplitOutputHandleId(0)).replace("output-", ""),
  );
  return Number.isInteger(index)
    ? splitRuntimeValueOutput(inputValue, index)
    : null;
}

function resolveOutputMergeRuntimeValue(
  document: WorkflowDocument,
  node: Extract<WorkflowDocumentNode, { kind: "outputMerge" }>,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
): RuntimeValue | null {
  const values = getOutputTransformInputValues(
    document,
    node.id,
    OUTPUT_TRANSFORM_INPUT_HANDLE_ID,
    path,
    nodeMap,
    incomingByTarget,
  ).filter((value) => value.type === node.valueType);
  return mergeRuntimeValues(values);
}

function resolveOutputZipAlignRuntimeValue(
  document: WorkflowDocument,
  node: Extract<WorkflowDocumentNode, { kind: "outputZipAlign" }>,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
): RuntimeValue | null {
  const values = getOutputTransformInputValues(
    document,
    node.id,
    OUTPUT_TRANSFORM_INPUT_HANDLE_ID,
    path,
    nodeMap,
    incomingByTarget,
  ).filter((value) => value.type === node.valueType);
  return zipAlignRuntimeValues(values, {
    broadcast: node.mode === "broadcast",
  });
}

function getGeneratorRepeatableHandlePrefixes(
  node: WorkflowDocumentNode,
  edges: WorkflowDocumentEdge[],
) {
  return Array.from(
    new Set(
      getGeneratorHandleDefinitions(node, edges)
        .flatMap((handle) =>
          handle.inputType === "repeatable" ? [handle.idPrefix] : [],
        )
        .filter(Boolean),
    ),
  );
}

export function getGeneratorInputHandles(
  document: WorkflowDocument,
  targetId: string,
) {
  const node = document.nodes.find((candidate) => candidate.id === targetId);
  if (!node) {
    return [];
  }

  return getGeneratorHandleDefinitions(node, document.edges);
}

export function getWorkflowHandleValueType(
  document: WorkflowDocument,
  handle: WorkflowHandleReference,
) {
  const node = document.nodes.find(
    (candidate) => candidate.id === handle.nodeId,
  );
  if (!node) {
    return null;
  }

  return handle.handleType === "source"
    ? getNodeOutputValueType(node, handle.handleId)
    : getNodeInputValueType(node, handle.handleId, document.edges);
}

export function normalizeOutputReorderValueTypes(
  nodes: WorkflowDocumentNode[],
  edges: WorkflowDocumentEdge[],
) {
  const incomingByTarget = buildIncomingByTarget(edges);
  const document = { nodes, edges } as WorkflowDocument;
  let didChange = false;

  const normalizedNodes = nodes.map((node) => {
    if (
      node.kind !== "outputReorder" &&
      node.kind !== "outputSelect" &&
      node.kind !== "outputSplit" &&
      node.kind !== "outputMerge" &&
      node.kind !== "outputZipAlign"
    ) {
      return node;
    }

    const inputHandleId =
      node.kind === "outputReorder"
        ? OUTPUT_REORDER_INPUT_HANDLE_ID
        : OUTPUT_TRANSFORM_INPUT_HANDLE_ID;
    const inputEdges = getIncomingEdgesForHandle(
      incomingByTarget,
      node.id,
      inputHandleId,
    );
    const inputEdge = inputEdges[0] ?? null;
    const inputValueType = inputEdge
      ? getWorkflowHandleValueType(document, {
          nodeId: inputEdge.source,
          handleId: inputEdge.sourceHandle,
          handleType: "source",
        })
      : null;

    if (node.valueType === inputValueType) {
      return node;
    }

    didChange = true;
    return {
      ...node,
      valueType: inputValueType,
    };
  });

  return didChange ? normalizedNodes : nodes;
}

export function findFirstWorkflowHandleIdByValueType(
  document: WorkflowDocument,
  params: {
    nodeId: string;
    handleType: HandleType;
    valueType: WorkflowValueType;
  },
) {
  const node = document.nodes.find(
    (candidate) => candidate.id === params.nodeId,
  );
  if (!node) {
    return null;
  }

  if (params.handleType === "source") {
    const handleId = getNodeOutputHandleId(node.kind);
    return getNodeOutputValueType(node, handleId) === params.valueType
      ? handleId
      : null;
  }

  if (node.kind === "outputReorder") {
    return OUTPUT_REORDER_INPUT_HANDLE_ID;
  }

  if (
    node.kind === "outputSelect" ||
    node.kind === "outputSplit" ||
    node.kind === "outputMerge" ||
    node.kind === "outputZipAlign"
  ) {
    return OUTPUT_TRANSFORM_INPUT_HANDLE_ID;
  }

  if (node.kind === "prompt") {
    return params.valueType === "text"
      ? (getPromptHandleDefinitions(node)[0]?.id ?? null)
      : null;
  }

  if (!isGeneratorNodeKind(node.kind)) {
    return null;
  }

  return (
    getGeneratorHandleDefinitions(node, document.edges).find(
      (handle) => handle.valueType === params.valueType,
    )?.id ?? null
  );
}

export function normalizeGeneratorTargetHandles(
  nodes: WorkflowDocumentNode[],
  edges: WorkflowDocumentEdge[],
) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const nextIndexByTargetPrefix = new Map<string, number>();
  let didChange = false;

  const normalizedEdges = edges.map((edge) => {
    const targetNode = nodeMap.get(edge.target);
    if (!targetNode || !isGeneratorNodeKind(targetNode.kind)) {
      return edge;
    }

    const repeatablePrefixes = getGeneratorRepeatableHandlePrefixes(
      targetNode,
      edges,
    );
    const matchedPrefix = repeatablePrefixes.find((prefix) =>
      edge.targetHandle?.startsWith(prefix),
    );

    if (!matchedPrefix) {
      return edge;
    }

    const key = `${edge.target}::${matchedPrefix}`;
    const nextIndex = nextIndexByTargetPrefix.get(key) ?? 0;
    nextIndexByTargetPrefix.set(key, nextIndex + 1);

    const targetHandle = `${matchedPrefix}${nextIndex}`;
    if (edge.targetHandle === targetHandle) {
      return edge;
    }

    didChange = true;
    return { ...edge, targetHandle };
  });

  return didChange ? normalizedEdges : edges;
}

function getNodeOutputValueType(
  node: WorkflowDocumentNode,
  handleId: string | null | undefined,
): WorkflowValueType | null {
  const normalizedHandleId = handleId ?? getNodeOutputHandleId(node.kind);

  switch (node.kind) {
    case "list":
      return normalizedHandleId === "text" ? "text" : null;
    case "prompt":
      return normalizedHandleId === "text" ? "text" : null;
    case "asset":
      return normalizedHandleId === "asset" ? node.assetKind : null;
    case "outputReorder":
      return normalizedHandleId === OUTPUT_REORDER_OUTPUT_HANDLE_ID
        ? node.valueType
        : null;
    case "outputSelect":
    case "outputMerge":
    case "outputZipAlign":
      return normalizedHandleId === OUTPUT_TRANSFORM_OUTPUT_HANDLE_ID
        ? node.valueType
        : null;
    case "outputSplit": {
      const outputIndex = Number(normalizedHandleId.replace("output-", ""));
      return Number.isInteger(outputIndex) &&
        outputIndex >= 0 &&
        outputIndex < node.splitCount
        ? node.valueType
        : null;
    }
    case "imageGenerator":
      return normalizedHandleId === "images" ? "image" : null;
    case "videoGenerator":
      return normalizedHandleId === "videos" ? "video" : null;
    case "llmGenerator":
      return normalizedHandleId === "text" ? "text" : null;
  }
}

function getNodeInputValueType(
  node: WorkflowDocumentNode,
  handleId: string | null | undefined,
  edges: WorkflowDocumentEdge[],
): WorkflowValueType | null {
  if (!handleId) {
    return null;
  }

  if (node.kind === "prompt") {
    return getPromptHandleDefinitions(node).some(
      (handle) => handle.id === handleId,
    )
      ? "text"
      : null;
  }

  if (node.kind === "outputReorder") {
    return handleId === OUTPUT_REORDER_INPUT_HANDLE_ID ? node.valueType : null;
  }

  if (
    node.kind === "outputSelect" ||
    node.kind === "outputSplit" ||
    node.kind === "outputMerge" ||
    node.kind === "outputZipAlign"
  ) {
    return handleId === OUTPUT_TRANSFORM_INPUT_HANDLE_ID
      ? node.valueType
      : null;
  }

  if (node.kind === "list" || !isGeneratorNodeKind(node.kind)) {
    return null;
  }

  return (
    getGeneratorHandleDefinitions(node, edges).find(
      (handle) => handle.id === handleId,
    )?.valueType ?? null
  );
}

export function getWorkflowNodeRuntimeValue(
  document: WorkflowDocument,
  nodeId: string,
  path: ReadonlySet<string> = new Set(),
  nodeMap = toNodeMap(document),
  incomingByTarget = buildIncomingByTarget(document.edges),
  sourceHandleId?: string | null,
): RuntimeValue | null {
  if (path.has(nodeId)) {
    return null;
  }

  const node = nodeMap.get(nodeId);
  if (!node) {
    return null;
  }

  const nextPath = new Set(path);
  nextPath.add(nodeId);

  switch (node.kind) {
    case "list":
      return toTextRuntimeValue(node.items);
    case "prompt": {
      const textValue = resolveRuntimePromptNodeText(
        document,
        node,
        nextPath,
        nodeMap,
        incomingByTarget,
      );

      return textValue;
    }
    case "asset":
      return node.assetKind && node.assets.length
        ? {
            type: node.assetKind,
            items: node.assets.map((asset) => [asset]),
          }
        : null;
    case "outputReorder":
      return resolveOutputReorderRuntimeValue(
        document,
        node,
        nextPath,
        nodeMap,
        incomingByTarget,
      );
    case "outputSelect":
      return resolveOutputSelectRuntimeValue(
        document,
        node,
        nextPath,
        nodeMap,
        incomingByTarget,
      );
    case "outputSplit":
      return resolveOutputSplitRuntimeValue(
        document,
        node,
        nextPath,
        nodeMap,
        incomingByTarget,
        sourceHandleId,
      );
    case "outputMerge":
      return resolveOutputMergeRuntimeValue(
        document,
        node,
        nextPath,
        nodeMap,
        incomingByTarget,
      );
    case "outputZipAlign":
      return resolveOutputZipAlignRuntimeValue(
        document,
        node,
        nextPath,
        nodeMap,
        incomingByTarget,
      );
    case "imageGenerator":
    case "videoGenerator":
    case "llmGenerator":
      return getWorkflowGeneratorOutputRuntimeValue(node);
  }
}

export function getWorkflowGeneratorRawOutputRuntimeValue(
  node: WorkflowDocumentNode,
): RuntimeValue | null {
  switch (node.kind) {
    case "imageGenerator": {
      const outputs = node.outputs.map((output) => output ?? []);
      return outputs.some((output) => output.length)
        ? {
            type: "image",
            items: outputs,
          }
        : null;
    }
    case "videoGenerator": {
      const outputs = node.outputs.map((output) => output ?? []);
      return outputs.some((output) => output.length)
        ? {
            type: "video",
            items: outputs,
          }
        : null;
    }
    case "llmGenerator": {
      const outputs = node.outputs.map((output) => output ?? "");
      return outputs.some((output) => output.trim())
        ? {
            type: "text",
            items: outputs,
          }
        : null;
    }
    default:
      return null;
  }
}

export function getWorkflowGeneratorOutputRuntimeValue(
  node: WorkflowDocumentNode,
  options?: { outputIndex?: number | null },
): RuntimeValue | null {
  const outputIndex = options?.outputIndex;
  if (
    (node.kind === "imageGenerator" ||
      node.kind === "videoGenerator" ||
      node.kind === "llmGenerator") &&
    node.reviewEnabled
  ) {
    const rawOutput = getWorkflowGeneratorRawOutputRuntimeValue(node);
    return rawOutput && outputIndex !== null && outputIndex !== undefined
      ? getApprovedReviewOutputRuntimeValue(node, outputIndex, {
          inputValue: rawOutput,
        })
      : rawOutput
        ? getApprovedReviewRuntimeValue(node, { inputValue: rawOutput })
        : null;
  }

  const rawOutput = getWorkflowGeneratorRawOutputRuntimeValue(node);
  return rawOutput && outputIndex !== null && outputIndex !== undefined
    ? getRuntimeValueOutput(rawOutput, outputIndex)
    : rawOutput;
}

export function getWorkflowGeneratorAwaitingReviewRuntimeValue(
  node: WorkflowDocumentNode,
  options?: { outputIndex?: number | null },
): RuntimeValue | null {
  const outputIndex = options?.outputIndex;
  if (
    node.kind !== "imageGenerator" &&
    node.kind !== "videoGenerator" &&
    node.kind !== "llmGenerator"
  ) {
    return null;
  }

  if (!node.reviewEnabled) {
    return null;
  }

  const rawOutput = getWorkflowGeneratorRawOutputRuntimeValue(node);
  if (!rawOutput) {
    return null;
  }

  const approvedOutput =
    outputIndex !== null && outputIndex !== undefined
      ? getApprovedReviewOutputRuntimeValue(node, outputIndex, {
          inputValue: rawOutput,
        })
      : getApprovedReviewRuntimeValue(node, { inputValue: rawOutput });

  if (approvedOutput) {
    return null;
  }

  return outputIndex !== null && outputIndex !== undefined
    ? getRuntimeValueOutput(rawOutput, outputIndex)
    : rawOutput;
}

function buildMediaBatchPlan(values: MediaRuntimeValue[]): MediaBatchPlan {
  if (!values.length) {
    return {
      batches: [[]],
      iterations: 1,
    };
  }

  for (const value of values) {
    if (!value.items.length) {
      throw new Error("Connected asset batch is empty.");
    }
  }

  const outputCount = getAlignedOutputCount(
    values.map((value) => value.items.length),
  );
  const batches = Array.from({ length: outputCount }, (_, index) =>
    values.flatMap((value) => getBroadcastOutput(value.items, index) ?? []),
  );

  return {
    batches,
    iterations: batches.length,
  };
}

export function buildGeneratorAssetBatchPlan(
  valuesByHandle: Record<string, MediaRuntimeValue[]>,
): GeneratorAssetBatchPlan {
  const plansByHandle = Object.entries(valuesByHandle).map(
    ([handleId, values]) => [handleId, buildMediaBatchPlan(values)] as const,
  );

  if (!plansByHandle.length) {
    return {
      batches: [{}],
      iterations: 1,
    };
  }

  const outputCount = getAlignedOutputCount(
    plansByHandle.map(([, plan]) => plan.iterations),
  );
  const batches = Array.from({ length: outputCount }, (_, index) =>
    Object.fromEntries(
      plansByHandle.map(([handleId, plan]) => [
        handleId,
        getBroadcastOutput(plan.batches, index) ?? [],
      ]),
    ),
  );

  return {
    batches,
    iterations: batches.length,
  };
}

export function buildGeneratorExecutionBatchPlan(params: {
  mediaPlan: GeneratorAssetBatchPlan;
  prompt: TextRuntimeValue | null;
  systemPrompt?: TextRuntimeValue | null;
}): GeneratorExecutionBatchPlan {
  const promptOutputs = params.prompt?.items.length
    ? params.prompt.items
    : [""];
  const systemPromptOutputs = params.systemPrompt?.items.length
    ? params.systemPrompt.items
    : [null];
  const outputCount = getAlignedOutputCount([
    promptOutputs.length,
    systemPromptOutputs.length,
    params.mediaPlan.iterations,
  ]);
  const batches = Array.from({ length: outputCount }, (_, index) => ({
    mediaInputsByHandle:
      getBroadcastOutput(params.mediaPlan.batches, index) ?? {},
    prompt: getBroadcastOutput(promptOutputs, index) ?? "",
    systemPrompt: getBroadcastOutput(systemPromptOutputs, index) ?? null,
  })).filter(
    (batch) =>
      batch.prompt.trim() ||
      Object.values(batch.mediaInputsByHandle).some((assets) => assets.length),
  );

  if (!batches.length) {
    throw new Error("Connected generator batch is empty.");
  }

  return {
    batches,
    hasIterator: batches.length > 1,
    iterations: batches.length,
  };
}

export function getGeneratorMediaValuesByHandle(
  document: WorkflowDocument,
  targetId: string,
  valueType: Extract<WorkflowValueType, "image" | "video">,
): Record<string, MediaRuntimeValue[]> {
  const nodeMap = toNodeMap(document);
  const targetNode = nodeMap.get(targetId);
  if (!targetNode || !isGeneratorNodeKind(targetNode.kind)) {
    return {} as Record<string, MediaRuntimeValue[]>;
  }

  const incomingByTarget = buildIncomingByTarget(document.edges);

  return Object.fromEntries(
    getGeneratorHandleDefinitions(targetNode, document.edges)
      .filter((handle) => handle.valueType === valueType)
      .map(
        (handle) =>
          [
            handle.id,
            getIncomingEdgesForHandle(
              incomingByTarget,
              targetId,
              handle.id,
            ).flatMap((edge) => {
              const sourceNode = nodeMap.get(edge.source);
              const runtimeValue = sourceNode
                ? getWorkflowNodeRuntimeValue(
                    document,
                    sourceNode.id,
                    new Set(),
                    undefined,
                    undefined,
                    edge.sourceHandle,
                  )
                : null;

              if (!runtimeValue || runtimeValue.type !== valueType) {
                return [];
              }

              return [runtimeValue];
            }),
          ] as const,
      )
      .filter(([, values]) => values.length),
  );
}

function edgeExists(
  edges: WorkflowDocumentEdge[],
  connection: Pick<
    Connection,
    "source" | "sourceHandle" | "target" | "targetHandle"
  >,
) {
  return edges.some(
    (edge) =>
      edge.source === connection.source &&
      edge.sourceHandle === (connection.sourceHandle ?? null) &&
      edge.target === connection.target &&
      edge.targetHandle === (connection.targetHandle ?? null),
  );
}

function conflictsWithSingleInputHandle(
  document: WorkflowDocument,
  connection: Pick<
    Connection,
    "source" | "sourceHandle" | "target" | "targetHandle"
  >,
) {
  if (
    connection.targetHandle !== OUTPUT_REORDER_INPUT_HANDLE_ID &&
    connection.targetHandle !== OUTPUT_TRANSFORM_INPUT_HANDLE_ID
  ) {
    return false;
  }

  const targetNode = document.nodes.find(
    (node) => node.id === connection.target,
  );
  return (
    (targetNode?.kind === "outputReorder" &&
      document.edges.some(
        (edge) =>
          edge.target === connection.target &&
          edge.targetHandle === OUTPUT_REORDER_INPUT_HANDLE_ID,
      )) ||
    ((targetNode?.kind === "outputSelect" ||
      targetNode?.kind === "outputSplit") &&
      document.edges.some(
        (edge) =>
          edge.target === connection.target &&
          edge.targetHandle === OUTPUT_TRANSFORM_INPUT_HANDLE_ID,
      ))
  );
}

function hasCompatibleConnection(
  document: WorkflowDocument,
  connection: Pick<
    Connection,
    "source" | "sourceHandle" | "target" | "targetHandle"
  >,
) {
  if (!connection.source || !connection.target) {
    return false;
  }

  const nodeMap = toNodeMap(document);
  const sourceNode = nodeMap.get(connection.source);
  const targetNode = nodeMap.get(connection.target);

  if (!sourceNode || !targetNode) {
    return false;
  }

  const sourceValueType = getNodeOutputValueType(
    sourceNode,
    connection.sourceHandle,
  );
  const targetValueType = getNodeInputValueType(
    targetNode,
    connection.targetHandle,
    document.edges,
  );

  if (sourceNode.kind === "outputSplit") {
    const outputIndex = Number(
      (connection.sourceHandle ?? "").replace("output-", ""),
    );
    const inputValue = getOutputTransformInputValue(document, sourceNode.id);

    if (
      inputValue?.type === sourceNode.valueType &&
      Number.isInteger(outputIndex) &&
      outputIndex >= inputValue.items.length
    ) {
      return false;
    }
  }

  if (
    targetNode.kind === "outputReorder" &&
    connection.targetHandle === OUTPUT_REORDER_INPUT_HANDLE_ID
  ) {
    return Boolean(
      sourceValueType &&
        (!targetNode.valueType || targetNode.valueType === sourceValueType),
    );
  }

  if (
    (targetNode.kind === "outputSelect" ||
      targetNode.kind === "outputSplit" ||
      targetNode.kind === "outputMerge" ||
      targetNode.kind === "outputZipAlign") &&
    connection.targetHandle === OUTPUT_TRANSFORM_INPUT_HANDLE_ID
  ) {
    return Boolean(
      sourceValueType &&
        (!targetNode.valueType || targetNode.valueType === sourceValueType),
    );
  }

  if (!sourceValueType || !targetValueType) {
    return false;
  }

  return sourceValueType === targetValueType;
}

export function wouldCreateWorkflowCycle(
  document: WorkflowDocument,
  connection: Pick<Connection, "source" | "target">,
) {
  if (!connection.source || !connection.target) {
    return false;
  }

  if (connection.source === connection.target) {
    return true;
  }

  const outgoingBySource = buildOutgoingBySource(document.edges);
  const stack = [connection.target];
  const visited = new Set<string>();

  while (stack.length) {
    const currentId = stack.pop();
    if (!currentId || visited.has(currentId)) {
      continue;
    }

    if (currentId === connection.source) {
      return true;
    }

    visited.add(currentId);
    for (const edge of outgoingBySource.get(currentId) ?? []) {
      stack.push(edge.target);
    }
  }

  return false;
}

export function isValidWorkflowConnection(
  document: WorkflowDocument,
  connection: Pick<
    Connection,
    "source" | "sourceHandle" | "target" | "targetHandle"
  >,
) {
  if (!hasCompatibleConnection(document, connection)) {
    return false;
  }

  if (edgeExists(document.edges, connection)) {
    return false;
  }

  if (conflictsWithSingleInputHandle(document, connection)) {
    return false;
  }

  return !wouldCreateWorkflowCycle(document, connection);
}

export function isValidWorkflowEdge(
  document: WorkflowDocument,
  edge: WorkflowDocumentEdge,
) {
  return hasCompatibleConnection(document, edge);
}

export function getPromptInputHandles(
  document: WorkflowDocument,
  targetId: string,
) {
  const node = document.nodes.find((candidate) => candidate.id === targetId);
  return node?.kind === "prompt" ? getPromptHandleDefinitions(node) : [];
}

export function getPromptVariableValue(
  document: WorkflowDocument,
  targetId: string,
  handleId: string,
) {
  const nodeMap = toNodeMap(document);
  const incomingByTarget = buildIncomingByTarget(document.edges);

  const value = resolveTextHandleValue(
    document,
    nodeMap,
    incomingByTarget,
    targetId,
    handleId,
    new Set([targetId]),
  );

  return value ? value.items.join("\n\n") : null;
}
