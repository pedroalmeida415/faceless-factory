import type { Connection, HandleType } from "reactflow";

import type {
  WorkflowDocument,
  WorkflowDocumentEdge,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import {
  type GeneratorHandleDefinition,
  getImageGeneratorHandleDefinitions,
  getVideoGeneratorHandleDefinitions,
} from "~/lib/workflow/generator-models";
import {
  getNodeOutputHandleId,
  type WorkflowValueType,
} from "~/lib/workflow/node-definitions";
import { isGeneratorNodeKind, type WorkflowAsset } from "~/lib/workflow/types";

export type RuntimeValue =
  | { type: "text"; text: string }
  | {
      type: "image" | "video";
      assets: WorkflowAsset[];
      iterationMode: "static" | "iterator";
    };

export type WorkflowHandleReference = {
  nodeId: string;
  handleId: string | null;
  handleType: HandleType;
};

type MediaRuntimeValue = Extract<RuntimeValue, { type: "image" | "video" }>;

type MediaBatchPlan = {
  batches: WorkflowAsset[][];
  hasIterator: boolean;
  iterations: number;
};

export type GeneratorAssetBatchPlan = {
  batches: Record<string, WorkflowAsset[]>[];
  hasIterator: boolean;
  iterations: number;
};

export type GeneratorIterationInfo = {
  hasIterator: boolean;
  iterations: number;
  mismatchedIterators: boolean;
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
    default:
      return [];
  }
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
    case "prompt":
      return normalizedHandleId === "text" ? "text" : null;
    case "asset":
      return normalizedHandleId === "asset" ? node.assetKind : null;
    case "imageGenerator":
      return normalizedHandleId === "images" ? "image" : null;
    case "videoGenerator":
      return normalizedHandleId === "videos" ? "video" : null;
  }
}

function getNodeInputValueType(
  node: WorkflowDocumentNode,
  handleId: string | null | undefined,
  edges: WorkflowDocumentEdge[],
): WorkflowValueType | null {
  if (!isGeneratorNodeKind(node.kind) || !handleId) {
    return null;
  }

  return (
    getGeneratorHandleDefinitions(node, edges).find(
      (handle) => handle.id === handleId,
    )?.valueType ?? null
  );
}

function toRuntimeValue(node: WorkflowDocumentNode): RuntimeValue | null {
  switch (node.kind) {
    case "prompt":
      return node.prompt.trim()
        ? {
            type: "text",
            text: node.prompt.trim(),
          }
        : null;
    case "asset":
      return node.assetKind && node.assets.length
        ? {
            type: node.assetKind,
            assets: node.assets,
            iterationMode: node.assets.length > 1 ? "iterator" : "static",
          }
        : null;
    case "imageGenerator":
      return node.outputAssets.length
        ? {
            type: "image",
            assets: node.outputAssets,
            iterationMode: "static",
          }
        : null;
    case "videoGenerator":
      return node.outputAssets.length
        ? {
            type: "video",
            assets: node.outputAssets,
            iterationMode: "static",
          }
        : null;
  }
}

function buildMediaBatchPlan(values: MediaRuntimeValue[]): MediaBatchPlan {
  const staticAssets = values.flatMap((value) =>
    value.iterationMode === "static" ? value.assets : [],
  );
  const iteratorValues = values.filter(
    (value) => value.iterationMode === "iterator",
  );

  if (!iteratorValues.length) {
    return {
      batches: [staticAssets],
      hasIterator: false,
      iterations: 1,
    };
  }

  const firstIterator = iteratorValues[0];
  if (!firstIterator?.assets.length) {
    throw new Error("Connected asset batch is empty.");
  }

  for (const iteratorValue of iteratorValues) {
    if (!iteratorValue.assets.length) {
      throw new Error("Connected asset batch is empty.");
    }
  }

  const iteratorCombinations = iteratorValues.reduce<WorkflowAsset[][]>(
    (combinations, iteratorValue) =>
      combinations.flatMap((combination) =>
        iteratorValue.assets.map((asset) => [...combination, asset]),
      ),
    [[]],
  );

  return {
    batches: iteratorCombinations.map((assets) => [...staticAssets, ...assets]),
    hasIterator: true,
    iterations: iteratorCombinations.length,
  };
}

export function buildGeneratorAssetBatchPlan(
  valuesByHandle: Record<string, MediaRuntimeValue[]>,
): GeneratorAssetBatchPlan {
  const plansByHandle = Object.entries(valuesByHandle).map(
    ([handleId, values]) => [handleId, buildMediaBatchPlan(values)] as const,
  );

  if (!plansByHandle.some(([, plan]) => plan.hasIterator)) {
    return {
      batches: [
        Object.fromEntries(
          plansByHandle.map(([handleId, plan]) => [
            handleId,
            plan.batches[0] ?? [],
          ]),
        ),
      ],
      hasIterator: false,
      iterations: 1,
    };
  }

  const combinations = plansByHandle.reduce<
    Array<Array<readonly [string, WorkflowAsset[]]>>
  >(
    (currentCombinations, [handleId, plan]) =>
      currentCombinations.flatMap((combination) =>
        plan.batches.map((batch) => [
          ...combination,
          [handleId, batch] as const,
        ]),
      ),
    [[]],
  );

  return {
    batches: combinations.map((combination) => Object.fromEntries(combination)),
    hasIterator: true,
    iterations: combinations.length,
  };
}

export function getGeneratorIterationPreview(
  document: WorkflowDocument,
  targetId: string,
): GeneratorIterationInfo {
  const nodeMap = toNodeMap(document);
  const targetNode = nodeMap.get(targetId);
  if (!targetNode || !isGeneratorNodeKind(targetNode.kind)) {
    return {
      hasIterator: false,
      iterations: 1,
      mismatchedIterators: false,
    };
  }

  const incomingByTarget = buildIncomingByTarget(document.edges);
  const imageHandles = getGeneratorHandleDefinitions(
    targetNode,
    document.edges,
  ).filter((handle) => handle.valueType === "image");
  const iterationCounts = imageHandles.flatMap((handle) =>
    getIncomingEdgesForHandle(incomingByTarget, targetId, handle.id).flatMap(
      (edge) => {
        const sourceNode = nodeMap.get(edge.source);
        const runtimeValue = sourceNode ? toRuntimeValue(sourceNode) : null;
        return runtimeValue?.type === "image" &&
          runtimeValue.iterationMode === "iterator"
          ? [runtimeValue.assets.length]
          : [];
      },
    ),
  );

  if (!iterationCounts.length) {
    return {
      hasIterator: false,
      iterations: 1,
      mismatchedIterators: false,
    };
  }

  return {
    hasIterator: true,
    iterations: iterationCounts.reduce(
      (totalIterations, count) => totalIterations * count,
      1,
    ),
    mismatchedIterators: false,
  };
}

export function getGeneratorMediaValuesByHandle(
  document: WorkflowDocument,
  targetId: string,
  valueType: Extract<WorkflowValueType, "image" | "video">,
) {
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
                ? toRuntimeValue(sourceNode)
                : null;
              return runtimeValue?.type === valueType ? [runtimeValue] : [];
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
