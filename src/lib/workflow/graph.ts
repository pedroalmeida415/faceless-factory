import type { Connection } from "reactflow";

import type {
  WorkflowDocument,
  WorkflowDocumentEdge,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import {
  getGeneratorImageInputColor,
  getNodeInputValueType,
  getNodeOutputValueType,
  type HandleDefinition,
  isGeneratorImageHandle,
  makeGeneratorImageHandleId,
} from "~/lib/workflow/node-definitions";
import { isGeneratorNodeKind, type WorkflowAsset } from "~/lib/workflow/types";

export type RuntimeValue =
  | { type: "text"; text: string }
  | {
      type: "image";
      assets: WorkflowAsset[];
      iterationMode: "static" | "iterator";
    }
  | { type: "video"; assets: WorkflowAsset[] };

type ImageRuntimeValue = Extract<RuntimeValue, { type: "image" }>;

export type ImageBatchPlan = {
  batches: WorkflowAsset[][];
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

export function getIncomingGeneratorImageEdges(
  incomingByTarget: Map<string, WorkflowDocumentEdge[]>,
  targetId: string,
) {
  return (incomingByTarget.get(targetId) ?? []).filter((edge) =>
    isGeneratorImageHandle(edge.targetHandle),
  );
}

export function getGeneratorImageInputHandles(
  edges: WorkflowDocumentEdge[],
  targetId: string,
): HandleDefinition[] {
  const connectedCount = edges.filter(
    (edge) =>
      edge.target === targetId && isGeneratorImageHandle(edge.targetHandle),
  ).length;

  return Array.from({ length: connectedCount + 1 }, (_, index) => ({
    id: makeGeneratorImageHandleId(index),
    label: "Image",
    color: getGeneratorImageInputColor(),
  }));
}

export function normalizeGeneratorImageTargetHandles(
  nodes: WorkflowDocumentNode[],
  edges: WorkflowDocumentEdge[],
) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const nextImageHandleByTarget = new Map<string, number>();

  return edges.map((edge) => {
    const targetNode = nodeMap.get(edge.target);
    if (!targetNode || !isGeneratorNodeKind(targetNode.kind)) {
      return edge;
    }

    if (!isGeneratorImageHandle(edge.targetHandle)) {
      return edge;
    }

    const nextIndex = nextImageHandleByTarget.get(edge.target) ?? 0;
    nextImageHandleByTarget.set(edge.target, nextIndex + 1);

    const targetHandle = makeGeneratorImageHandleId(nextIndex);
    return edge.targetHandle === targetHandle
      ? edge
      : { ...edge, targetHandle };
  });
}

function toImageRuntimeValue(
  node: WorkflowDocumentNode,
): ImageRuntimeValue | null {
  switch (node.kind) {
    case "image":
      return node.asset
        ? {
            type: "image",
            assets: [node.asset],
            iterationMode: "static",
          }
        : null;
    case "imageIterator":
      return {
        type: "image",
        assets: node.assets,
        iterationMode: "iterator",
      };
    case "imageGenerator":
      return node.outputAssets.length
        ? {
            type: "image",
            assets: node.outputAssets,
            iterationMode: "static",
          }
        : null;
    default:
      return null;
  }
}

export function buildImageBatchPlan(
  values: ImageRuntimeValue[],
): ImageBatchPlan {
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
    throw new Error("Image iterator is empty.");
  }

  for (const iteratorValue of iteratorValues) {
    if (iteratorValue.assets.length !== firstIterator.assets.length) {
      throw new Error(
        "Connected image iterators must contain the same number of images.",
      );
    }
  }

  return {
    batches: firstIterator.assets.map((_, index) => [
      ...staticAssets,
      ...iteratorValues
        .map((iteratorValue) => iteratorValue.assets[index])
        .filter((asset): asset is WorkflowAsset => Boolean(asset)),
    ]),
    hasIterator: true,
    iterations: firstIterator.assets.length,
  };
}

export function getGeneratorIterationPreview(
  document: WorkflowDocument,
  targetId: string,
): GeneratorIterationInfo {
  const nodeMap = toNodeMap(document);
  const incomingByTarget = buildIncomingByTarget(document.edges);
  const imageValues = getIncomingGeneratorImageEdges(incomingByTarget, targetId)
    .flatMap((edge) => {
      const sourceNode = nodeMap.get(edge.source);
      if (!sourceNode) {
        return [];
      }

      const imageValue = toImageRuntimeValue(sourceNode);
      return imageValue ? [imageValue] : [];
    })
    .filter((value) => value.iterationMode === "iterator");

  if (!imageValues.length) {
    return {
      hasIterator: false,
      iterations: 1,
      mismatchedIterators: false,
    };
  }

  const iterationCounts = imageValues.map((value) => value.assets.length);
  const firstCount = iterationCounts[0] ?? 0;
  const mismatchedIterators = iterationCounts.some(
    (count) => count !== firstCount,
  );

  return {
    hasIterator: true,
    iterations: mismatchedIterators ? Math.max(...iterationCounts) : firstCount,
    mismatchedIterators,
  };
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
    sourceNode.kind,
    connection.sourceHandle,
  );
  const targetValueType = getNodeInputValueType(
    targetNode.kind,
    connection.targetHandle,
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
