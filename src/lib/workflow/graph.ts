import type { Connection, HandleType } from "reactflow";

import type {
  PromptWorkflowNode,
  WorkflowDocument,
  WorkflowDocumentEdge,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import {
  type GeneratorHandleDefinition,
  getImageGeneratorHandleDefinitions,
  getVideoGeneratorHandleDefinitions,
} from "~/lib/workflow/generator-models";
import { getLlmGeneratorHandleDefinitions } from "~/lib/workflow/llm-models";
import {
  getNodeOutputHandleId,
  PROMPT_VARIABLE_HANDLE_COLOR,
  PROMPT_VARIABLE_PATTERN,
  type WorkflowValueType,
} from "~/lib/workflow/node-definitions";
import { isGeneratorNodeKind, type WorkflowAsset } from "~/lib/workflow/types";

export type TextRuntimeValue = {
  type: "text";
  lanes: string[];
};

export type MediaRuntimeValue = {
  type: "image" | "video";
  lanes: WorkflowAsset[][];
};

export type RuntimeValue = TextRuntimeValue | MediaRuntimeValue;

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
    case "imageGenerator":
    case "videoGenerator":
    case "llmGenerator":
      return getWorkflowGeneratorOutputRuntimeValue(node);
  }
}

export function getWorkflowGeneratorOutputRuntimeValue(
  node: WorkflowDocumentNode,
): RuntimeValue | null {
  switch (node.kind) {
    case "imageGenerator": {
      return node.outputLanes.length
        ? {
            type: "image",
            lanes: node.outputLanes,
          }
        : null;
    }
    case "videoGenerator": {
      return node.outputLanes.length
        ? {
            type: "video",
            lanes: node.outputLanes,
          }
        : null;
    }
    case "llmGenerator":
      return node.responseText?.trim()
        ? toTextRuntimeValue([node.responseText])
        : null;
    default:
      return null;
  }
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
  prompt: TextRuntimeValue;
  systemPrompt?: TextRuntimeValue | null;
}): GeneratorExecutionBatchPlan {
  const systemPromptLanes = params.systemPrompt?.lanes.length
    ? params.systemPrompt.lanes
    : [null];
  const laneCount = getAlignedLaneCount([
    params.prompt.lanes.length,
    systemPromptLanes.length,
    params.mediaPlan.iterations,
  ]);
  const batches = Array.from({ length: laneCount }, (_, index) => ({
    mediaInputsByHandle:
      getBroadcastLane(params.mediaPlan.batches, index) ?? {},
    prompt: getBroadcastLane(params.prompt.lanes, index) ?? "",
    systemPrompt: getBroadcastLane(systemPromptLanes, index) ?? null,
  })).filter((batch) => batch.prompt);

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
                ? getWorkflowNodeRuntimeValue(document, sourceNode.id)
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
