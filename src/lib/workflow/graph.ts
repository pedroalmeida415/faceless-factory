import type { Connection, HandleType } from "reactflow";

import type {
  PromptWorkflowNode,
  WorkflowDocument,
  WorkflowDocumentEdge,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { getRuntimeValueLane } from "~/lib/workflow/execution/output-lanes";
import {
  type GeneratorHandleDefinition,
  getImageGeneratorHandleDefinitions,
  getVideoGeneratorHandleDefinitions,
} from "~/lib/workflow/generator-models";
import {
  type MediaRuntimeValue,
  mergeRuntimeValues,
  type RuntimeValue,
  reorderRuntimeValue,
  resolveLanePermutation,
  selectRuntimeValue,
  splitRuntimeValueLane,
  type TextRuntimeValue,
  zipAlignRuntimeValues,
} from "~/lib/workflow/lanes";
import { getLlmGeneratorHandleDefinitions } from "~/lib/workflow/llm-models";
import {
  getLaneSplitOutputHandleId,
  getNodeOutputHandleId,
  LANE_ACCUMULATOR_INPUT_HANDLE_ID,
  LANE_ACCUMULATOR_OUTPUT_HANDLE_ID,
  LANE_REORDER_INPUT_HANDLE_ID,
  LANE_REORDER_OUTPUT_HANDLE_ID,
  LANE_TRANSFORM_INPUT_HANDLE_ID,
  LANE_TRANSFORM_OUTPUT_HANDLE_ID,
  PROMPT_VARIABLE_HANDLE_COLOR,
  PROMPT_VARIABLE_PATTERN,
  type WorkflowValueType,
} from "~/lib/workflow/node-definitions";
import {
  getApprovedReviewLaneRuntimeValue,
  getApprovedReviewRuntimeValue,
} from "~/lib/workflow/review-state";
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
  lanes: string[];
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

export function getAlignedLaneCount(counts: readonly number[]) {
  const laneCounts = counts.filter((count) => count > 0);
  if (!laneCounts.length) {
    return 1;
  }

  const laneCount = Math.max(...laneCounts);
  const mismatchedCount = laneCounts.find(
    (count) => count !== 1 && count !== laneCount,
  );

  if (mismatchedCount !== undefined) {
    throw new Error("Connected input lane counts do not match.");
  }

  return laneCount;
}

function getBroadcastLane<T>(lanes: readonly T[], index: number) {
  return lanes.length === 1 ? lanes[0] : lanes[index];
}

function toTextRuntimeValue(
  values: readonly string[],
): TextRuntimeValue | null {
  const normalizedValues = normalizeTextValues(values);

  return normalizedValues.length
    ? {
        type: "text",
        lanes: normalizedValues,
      }
    : null;
}

export function buildTextBatchPlan(
  values: readonly TextRuntimeValue[],
): TextBatchPlan {
  const laneGroups = values.map((value) => normalizeTextValues(value.lanes));

  if (!laneGroups.length) {
    return {
      lanes: [],
      iterations: 1,
    };
  }

  for (const lanes of laneGroups) {
    if (!lanes.length) {
      throw new Error("Connected text batch is empty.");
    }
  }

  const laneCount = getAlignedLaneCount(
    laneGroups.map((lanes) => lanes.length),
  );
  const resolvedLanes = Array.from({ length: laneCount }, (_, index) =>
    joinTextValues(
      laneGroups.flatMap((lanes) => getBroadcastLane(lanes, index) ?? []),
    ),
  ).filter(Boolean);

  if (!resolvedLanes.length) {
    throw new Error("Connected text batch is empty.");
  }

  return {
    lanes: resolvedLanes,
    iterations: resolvedLanes.length,
  };
}

export function buildTextRuntimeValue(
  values: readonly TextRuntimeValue[],
): TextRuntimeValue | null {
  const plan = buildTextBatchPlan(values);
  return toTextRuntimeValue(plan.lanes);
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

  const laneEntries = Array.from(resolvedByKey.entries()).flatMap(
    ([key, value]) => {
      if (!value) {
        return [];
      }

      const lanes = normalizeTextValues(value.lanes);
      if (!lanes.length) {
        return null;
      }

      return [[key, lanes] as const];
    },
  );
  if (laneEntries.some((entry) => entry === null)) {
    return null;
  }

  const textLaneEntries = laneEntries.filter(
    (entry): entry is readonly [string, string[]] => entry !== null,
  );
  const laneCount = getAlignedLaneCount(
    textLaneEntries.map(([, lanes]) => lanes.length),
  );
  const resolvedPrompts = Array.from({ length: laneCount }, (_, index) => {
    const prompt = node.prompt.replace(
      PROMPT_VARIABLE_PATTERN,
      (match, key) => {
        if (!variableKeys.has(key)) {
          return match;
        }

        const lanes = textLaneEntries.find(
          ([entryKey]) => entryKey === key,
        )?.[1];
        return lanes ? (getBroadcastLane(lanes, index) ?? "") : "";
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

export function getLaneReorderInputValue(
  document: WorkflowDocument,
  nodeId: string,
  path: ReadonlySet<string> = new Set(),
  nodeMap = toNodeMap(document),
  incomingByTarget = buildIncomingByTarget(document.edges),
): RuntimeValue | null {
  const incomingEdges = getIncomingEdgesForHandle(
    incomingByTarget,
    nodeId,
    LANE_REORDER_INPUT_HANDLE_ID,
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

export function getLaneTransformInputValue(
  document: WorkflowDocument,
  nodeId: string,
  path: ReadonlySet<string> = new Set(),
  nodeMap = toNodeMap(document),
  incomingByTarget = buildIncomingByTarget(document.edges),
): RuntimeValue | null {
  const incomingEdges = getIncomingEdgesForHandle(
    incomingByTarget,
    nodeId,
    LANE_TRANSFORM_INPUT_HANDLE_ID,
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

function getSingleInputValue(
  document: WorkflowDocument,
  nodeId: string,
  handleId: string,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
): RuntimeValue | null {
  const incomingEdges = getIncomingEdgesForHandle(
    incomingByTarget,
    nodeId,
    handleId,
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

export function getLaneAccumulatorInputValue(
  document: WorkflowDocument,
  nodeId: string,
  path: ReadonlySet<string> = new Set(),
  nodeMap = toNodeMap(document),
  incomingByTarget = buildIncomingByTarget(document.edges),
) {
  return getSingleInputValue(
    document,
    nodeId,
    LANE_ACCUMULATOR_INPUT_HANDLE_ID,
    path,
    nodeMap,
    incomingByTarget,
  );
}

function getLaneTransformInputValues(
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

function resolveLaneReorderRuntimeValue(
  document: WorkflowDocument,
  node: Extract<WorkflowDocumentNode, { kind: "laneReorder" }>,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
): RuntimeValue | null {
  const inputValue = getLaneReorderInputValue(
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
    resolveLanePermutation({
      laneCount: inputValue.lanes.length,
      mode: node.mode,
      order: node.order,
      shift: node.shift,
    }),
  );
}

function resolveLaneSelectRuntimeValue(
  document: WorkflowDocument,
  node: Extract<WorkflowDocumentNode, { kind: "laneSelect" }>,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
): RuntimeValue | null {
  const inputValue = getLaneTransformInputValue(
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

function resolveLaneSplitRuntimeValue(
  document: WorkflowDocument,
  node: Extract<WorkflowDocumentNode, { kind: "laneSplit" }>,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
  sourceHandleId: string | null | undefined,
): RuntimeValue | null {
  const inputValue = getLaneTransformInputValue(
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
    (sourceHandleId ?? getLaneSplitOutputHandleId(0)).replace("lane-", ""),
  );
  return Number.isInteger(index)
    ? splitRuntimeValueLane(inputValue, index)
    : null;
}

function resolveLaneMergeRuntimeValue(
  document: WorkflowDocument,
  node: Extract<WorkflowDocumentNode, { kind: "laneMerge" }>,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
): RuntimeValue | null {
  const values = getLaneTransformInputValues(
    document,
    node.id,
    LANE_TRANSFORM_INPUT_HANDLE_ID,
    path,
    nodeMap,
    incomingByTarget,
  ).filter((value) => value.type === node.valueType);
  return mergeRuntimeValues(values);
}

function resolveLaneZipAlignRuntimeValue(
  document: WorkflowDocument,
  node: Extract<WorkflowDocumentNode, { kind: "laneZipAlign" }>,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
): RuntimeValue | null {
  const values = getLaneTransformInputValues(
    document,
    node.id,
    LANE_TRANSFORM_INPUT_HANDLE_ID,
    path,
    nodeMap,
    incomingByTarget,
  ).filter((value) => value.type === node.valueType);
  return zipAlignRuntimeValues(values, {
    broadcast: node.mode === "broadcast",
  });
}

function resolveLaneAccumulatorRuntimeValue(
  document: WorkflowDocument,
  node: Extract<WorkflowDocumentNode, { kind: "laneAccumulator" }>,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
): RuntimeValue | null {
  const inputValue = getLaneAccumulatorInputValue(
    document,
    node.id,
    path,
    nodeMap,
    incomingByTarget,
  );
  return inputValue && inputValue.type === node.valueType ? inputValue : null;
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

export function normalizeLaneReorderValueTypes(
  nodes: WorkflowDocumentNode[],
  edges: WorkflowDocumentEdge[],
) {
  const incomingByTarget = buildIncomingByTarget(edges);
  const document = { nodes, edges } as WorkflowDocument;
  let didChange = false;

  const normalizedNodes = nodes.map((node) => {
    if (
      node.kind !== "laneReorder" &&
      node.kind !== "laneSelect" &&
      node.kind !== "laneSplit" &&
      node.kind !== "laneMerge" &&
      node.kind !== "laneZipAlign" &&
      node.kind !== "laneAccumulator"
    ) {
      return node;
    }

    const inputHandleId =
      node.kind === "laneReorder"
        ? LANE_REORDER_INPUT_HANDLE_ID
        : node.kind === "laneAccumulator"
          ? LANE_ACCUMULATOR_INPUT_HANDLE_ID
          : LANE_TRANSFORM_INPUT_HANDLE_ID;
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

  if (node.kind === "laneReorder") {
    return LANE_REORDER_INPUT_HANDLE_ID;
  }

  if (
    node.kind === "laneSelect" ||
    node.kind === "laneSplit" ||
    node.kind === "laneMerge" ||
    node.kind === "laneZipAlign"
  ) {
    return LANE_TRANSFORM_INPUT_HANDLE_ID;
  }

  if (node.kind === "laneAccumulator") {
    return LANE_ACCUMULATOR_INPUT_HANDLE_ID;
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
    case "laneReorder":
      return normalizedHandleId === LANE_REORDER_OUTPUT_HANDLE_ID
        ? node.valueType
        : null;
    case "laneSelect":
    case "laneMerge":
    case "laneZipAlign":
      return normalizedHandleId === LANE_TRANSFORM_OUTPUT_HANDLE_ID
        ? node.valueType
        : null;
    case "laneAccumulator":
      return normalizedHandleId === LANE_ACCUMULATOR_OUTPUT_HANDLE_ID
        ? node.valueType
        : null;
    case "laneSplit": {
      const outputIndex = Number(normalizedHandleId.replace("lane-", ""));
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

  if (node.kind === "laneReorder") {
    return handleId === LANE_REORDER_INPUT_HANDLE_ID ? node.valueType : null;
  }

  if (
    node.kind === "laneSelect" ||
    node.kind === "laneSplit" ||
    node.kind === "laneMerge" ||
    node.kind === "laneZipAlign"
  ) {
    return handleId === LANE_TRANSFORM_INPUT_HANDLE_ID ? node.valueType : null;
  }

  if (node.kind === "laneAccumulator") {
    return handleId === LANE_ACCUMULATOR_INPUT_HANDLE_ID
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
            lanes: node.assets.map((asset) => [asset]),
          }
        : null;
    case "laneReorder":
      return resolveLaneReorderRuntimeValue(
        document,
        node,
        nextPath,
        nodeMap,
        incomingByTarget,
      );
    case "laneSelect":
      return resolveLaneSelectRuntimeValue(
        document,
        node,
        nextPath,
        nodeMap,
        incomingByTarget,
      );
    case "laneSplit":
      return resolveLaneSplitRuntimeValue(
        document,
        node,
        nextPath,
        nodeMap,
        incomingByTarget,
        sourceHandleId,
      );
    case "laneMerge":
      return resolveLaneMergeRuntimeValue(
        document,
        node,
        nextPath,
        nodeMap,
        incomingByTarget,
      );
    case "laneZipAlign":
      return resolveLaneZipAlignRuntimeValue(
        document,
        node,
        nextPath,
        nodeMap,
        incomingByTarget,
      );
    case "laneAccumulator":
      return resolveLaneAccumulatorRuntimeValue(
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
      return node.outputLanes.some((lane) => lane.length)
        ? {
            type: "image",
            lanes: node.outputLanes,
          }
        : null;
    }
    case "videoGenerator": {
      return node.outputLanes.some((lane) => lane.length)
        ? {
            type: "video",
            lanes: node.outputLanes,
          }
        : null;
    }
    case "llmGenerator":
      return node.outputLanes.some((lane) => lane.trim())
        ? {
            type: "text",
            lanes: node.outputLanes,
          }
        : null;
    default:
      return null;
  }
}

export function getWorkflowGeneratorOutputRuntimeValue(
  node: WorkflowDocumentNode,
  options?: { laneIndex?: number | null },
): RuntimeValue | null {
  const laneIndex = options?.laneIndex;
  if (
    (node.kind === "imageGenerator" ||
      node.kind === "videoGenerator" ||
      node.kind === "llmGenerator") &&
    node.reviewEnabled
  ) {
    const rawOutput = getWorkflowGeneratorRawOutputRuntimeValue(node);
    return rawOutput && laneIndex !== null && laneIndex !== undefined
      ? getApprovedReviewLaneRuntimeValue(node, laneIndex, {
          inputValue: rawOutput,
        })
      : rawOutput
        ? getApprovedReviewRuntimeValue(node, { inputValue: rawOutput })
        : null;
  }

  const rawOutput = getWorkflowGeneratorRawOutputRuntimeValue(node);
  return rawOutput && laneIndex !== null && laneIndex !== undefined
    ? getRuntimeValueLane(rawOutput, laneIndex)
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
    if (!value.lanes.length) {
      throw new Error("Connected asset batch is empty.");
    }
  }

  const laneCount = getAlignedLaneCount(
    values.map((value) => value.lanes.length),
  );
  const batches = Array.from({ length: laneCount }, (_, index) =>
    values.flatMap((value) => getBroadcastLane(value.lanes, index) ?? []),
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

  const laneCount = getAlignedLaneCount(
    plansByHandle.map(([, plan]) => plan.iterations),
  );
  const batches = Array.from({ length: laneCount }, (_, index) =>
    Object.fromEntries(
      plansByHandle.map(([handleId, plan]) => [
        handleId,
        getBroadcastLane(plan.batches, index) ?? [],
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
  const promptLanes = params.prompt?.lanes.length ? params.prompt.lanes : [""];
  const systemPromptLanes = params.systemPrompt?.lanes.length
    ? params.systemPrompt.lanes
    : [null];
  const laneCount = getAlignedLaneCount([
    promptLanes.length,
    systemPromptLanes.length,
    params.mediaPlan.iterations,
  ]);
  const batches = Array.from({ length: laneCount }, (_, index) => ({
    mediaInputsByHandle:
      getBroadcastLane(params.mediaPlan.batches, index) ?? {},
    prompt: getBroadcastLane(promptLanes, index) ?? "",
    systemPrompt: getBroadcastLane(systemPromptLanes, index) ?? null,
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
    connection.targetHandle !== LANE_REORDER_INPUT_HANDLE_ID &&
    connection.targetHandle !== LANE_TRANSFORM_INPUT_HANDLE_ID &&
    connection.targetHandle !== LANE_ACCUMULATOR_INPUT_HANDLE_ID
  ) {
    return false;
  }

  const targetNode = document.nodes.find(
    (node) => node.id === connection.target,
  );
  return (
    (targetNode?.kind === "laneReorder" &&
      document.edges.some(
        (edge) =>
          edge.target === connection.target &&
          edge.targetHandle === LANE_REORDER_INPUT_HANDLE_ID,
      )) ||
    ((targetNode?.kind === "laneSelect" || targetNode?.kind === "laneSplit") &&
      document.edges.some(
        (edge) =>
          edge.target === connection.target &&
          edge.targetHandle === LANE_TRANSFORM_INPUT_HANDLE_ID,
      )) ||
    (targetNode?.kind === "laneAccumulator" &&
      document.edges.some(
        (edge) =>
          edge.target === connection.target &&
          edge.targetHandle === LANE_ACCUMULATOR_INPUT_HANDLE_ID,
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

  if (sourceNode.kind === "laneSplit") {
    const outputIndex = Number(
      (connection.sourceHandle ?? "").replace("lane-", ""),
    );
    const inputValue = getLaneTransformInputValue(document, sourceNode.id);

    if (
      inputValue?.type === sourceNode.valueType &&
      Number.isInteger(outputIndex) &&
      outputIndex >= inputValue.lanes.length
    ) {
      return false;
    }
  }

  if (
    targetNode.kind === "laneReorder" &&
    connection.targetHandle === LANE_REORDER_INPUT_HANDLE_ID
  ) {
    return Boolean(
      sourceValueType &&
        (!targetNode.valueType || targetNode.valueType === sourceValueType),
    );
  }

  if (
    (targetNode.kind === "laneSelect" ||
      targetNode.kind === "laneSplit" ||
      targetNode.kind === "laneMerge" ||
      targetNode.kind === "laneZipAlign") &&
    connection.targetHandle === LANE_TRANSFORM_INPUT_HANDLE_ID
  ) {
    return Boolean(
      sourceValueType &&
        (!targetNode.valueType || targetNode.valueType === sourceValueType),
    );
  }

  if (
    targetNode.kind === "laneAccumulator" &&
    connection.targetHandle === LANE_ACCUMULATOR_INPUT_HANDLE_ID
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

  return value ? value.lanes.join("\n\n") : null;
}
