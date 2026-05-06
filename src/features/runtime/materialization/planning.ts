import { Data } from "effect";

import type { WorkflowDocument } from "~/features/workflow/document";
import {
  buildIncomingByTarget,
  getAlignedOutputCount,
  getGeneratorInputHandles,
  getIncomingEdgesForHandle,
  getPromptNodeReferencedVariableKeys,
  getWorkflowGeneratorAwaitingReviewRuntimeValue,
  getWorkflowGeneratorOutputRuntimeValue,
} from "~/features/workflow/graph";
import {
  OUTPUT_REORDER_INPUT_HANDLE_ID,
  PROMPT_VARIABLE_PATTERN,
  type WorkflowValueType,
} from "~/features/workflow/node-definitions";
import { getReviewOutputCount } from "~/features/workflow/review-state";
import { isGeneratorNodeKind } from "~/features/workflow/types";

class TaskRunMaterializationPlanningError extends Data.TaggedError(
  "TaskRunMaterializationPlanningError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type GeneratorIterationInfo = {
  hasIterator: boolean;
  iterations: number;
  mismatchedIterators: boolean;
};

type PlannedValue = {
  type: WorkflowValueType;
  outputCount: number;
  mismatched: boolean;
};

type PlanningContext = {
  document: WorkflowDocument;
  executableNodeIds: string[];
  generatorIterationById: Map<string, GeneratorIterationInfo>;
  incomingByTarget: ReturnType<typeof buildIncomingByTarget>;
  nodeMap: Map<string, WorkflowDocument["nodes"][number]>;
  reviewBarrierNodeIds: Set<string>;
  requiredNodeIds: Set<string>;
  targetNodeIdSet: Set<string>;
};

export type TaskRunMaterializationPlan = {
  targetNodeIds: string[];
  requiredNodeIds: Set<string>;
  executableNodeIds: string[];
  reviewBarrierNodeIds: string[];
  generatorIterationById: Map<string, GeneratorIterationInfo>;
};

const DEFAULT_GENERATOR_ITERATION_INFO: GeneratorIterationInfo = {
  hasIterator: false,
  iterations: 1,
  mismatchedIterators: false,
};

function failPlanning(message: string, cause?: unknown): never {
  throw new TaskRunMaterializationPlanningError({ message, cause });
}

function getNodeOutputValueType(
  node: WorkflowDocument["nodes"][number],
): WorkflowValueType | null {
  switch (node.kind) {
    case "list":
    case "prompt":
    case "llmGenerator":
      return "text";
    case "asset":
      return node.assetKind;
    case "outputReorder":
      return node.valueType;
    case "imageGenerator":
      return "image";
    case "videoGenerator":
      return "video";
  }
}

function isGeneratorNode(node: WorkflowDocument["nodes"][number] | undefined) {
  return node ? isGeneratorNodeKind(node.kind) : false;
}

function validateTargetNodes(
  document: WorkflowDocument,
  targetNodeIds: string[],
) {
  if (!targetNodeIds.length) {
    failPlanning("Add a generator first.");
  }

  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  for (const targetId of targetNodeIds) {
    const node = nodeMap.get(targetId);
    if (!node) {
      failPlanning(`Node ${targetId} not found.`);
    }
    if (!isGeneratorNode(node)) {
      failPlanning("Only generator nodes can be executed.");
    }
  }
}

function toGeneratorIterationInfo(
  values: readonly PlannedValue[],
): GeneratorIterationInfo {
  const outputCounts = values.map((value) => value.outputCount);
  const hasNestedMismatch = values.some((value) => value.mismatched);

  if (!outputCounts.length) {
    return DEFAULT_GENERATOR_ITERATION_INFO;
  }

  try {
    const iterations = getAlignedOutputCount(outputCounts);
    return {
      hasIterator: iterations > 1,
      iterations,
      mismatchedIterators: hasNestedMismatch,
    };
  } catch {
    return {
      hasIterator: true,
      iterations: Math.max(...outputCounts),
      mismatchedIterators: true,
    };
  }
}

function mergePlannedValues(
  type: WorkflowValueType,
  values: readonly PlannedValue[],
): PlannedValue | null {
  const filteredValues = values.filter((value) => value.type === type);
  if (!filteredValues.length) {
    return null;
  }

  const info = toGeneratorIterationInfo(filteredValues);
  return {
    type,
    outputCount: info.iterations,
    mismatched: info.mismatchedIterators,
  };
}

function hasPromptStaticText(
  node: Extract<WorkflowDocument["nodes"][number], { kind: "prompt" }>,
) {
  const variableKeys = new Set(node.variables.map((variable) => variable.key));
  return Boolean(
    node.prompt
      .replace(PROMPT_VARIABLE_PATTERN, (match, key) =>
        variableKeys.has(key) ? "" : match,
      )
      .trim(),
  );
}

function resolveTextHandlePlan(
  context: PlanningContext,
  targetId: string,
  handleId: string,
  path: ReadonlySet<string>,
) {
  return mergePlannedValues(
    "text",
    getIncomingEdgesForHandle(context.incomingByTarget, targetId, handleId)
      .map((edge) =>
        resolveNodePlan(context, edge.source, path, edge.sourceHandle),
      )
      .filter((value): value is PlannedValue => Boolean(value)),
  );
}

function resolvePromptPlan(
  context: PlanningContext,
  node: Extract<WorkflowDocument["nodes"][number], { kind: "prompt" }>,
  path: ReadonlySet<string>,
): PlannedValue | null {
  const variableValues = getPromptNodeReferencedVariableKeys(node)
    .map((key) => resolveTextHandlePlan(context, node.id, key, path))
    .filter((value): value is PlannedValue => Boolean(value));

  if (!variableValues.length) {
    return hasPromptStaticText(node)
      ? { outputCount: 1, mismatched: false, type: "text" }
      : null;
  }

  const info = toGeneratorIterationInfo(variableValues);
  return {
    type: "text",
    outputCount: info.iterations,
    mismatched: info.mismatchedIterators,
  };
}

function resolveGeneratorInputPlans(
  context: PlanningContext,
  nodeId: string,
  path: ReadonlySet<string>,
) {
  return getGeneratorInputHandles(context.document, nodeId).flatMap((handle) =>
    getIncomingEdgesForHandle(context.incomingByTarget, nodeId, handle.id)
      .map((edge) =>
        resolveNodePlan(context, edge.source, path, edge.sourceHandle),
      )
      .filter(
        (value): value is PlannedValue =>
          value !== null && value.type === handle.valueType,
      ),
  );
}

function planGeneratorNode(
  context: PlanningContext,
  node: Extract<
    WorkflowDocument["nodes"][number],
    { kind: "imageGenerator" | "videoGenerator" | "llmGenerator" }
  >,
  path: ReadonlySet<string>,
) {
  const existing = context.generatorIterationById.get(node.id);
  if (existing) {
    return existing;
  }

  context.executableNodeIds.push(node.id);
  context.generatorIterationById.set(node.id, DEFAULT_GENERATOR_ITERATION_INFO);

  const inputInfo = toGeneratorIterationInfo(
    resolveGeneratorInputPlans(context, node.id, path),
  );
  const reviewOutputCount = getReviewOutputCount(node);
  const info = {
    ...inputInfo,
    hasIterator: inputInfo.hasIterator || reviewOutputCount > 1,
    iterations: Math.max(inputInfo.iterations, reviewOutputCount),
  };
  context.generatorIterationById.set(node.id, info);
  return info;
}

function resolveNodePlan(
  context: PlanningContext,
  nodeId: string,
  path: ReadonlySet<string>,
  _sourceHandleId?: string | null,
): PlannedValue | null {
  if (path.has(nodeId)) {
    return null;
  }

  const node = context.nodeMap.get(nodeId);
  if (!node) {
    return null;
  }

  context.requiredNodeIds.add(node.id);
  const outputType = getNodeOutputValueType(node);
  if (!outputType) {
    return null;
  }

  const nextPath = new Set(path);
  nextPath.add(node.id);

  switch (node.kind) {
    case "list": {
      const outputCount = node.items.filter((item) => item.trim()).length;
      return outputCount
        ? { outputCount, mismatched: false, type: "text" }
        : null;
    }
    case "asset":
      return node.assetKind && node.assets.length
        ? {
            outputCount: node.assets.length,
            mismatched: false,
            type: node.assetKind,
          }
        : null;
    case "outputReorder": {
      const incomingEdges = getIncomingEdgesForHandle(
        context.incomingByTarget,
        node.id,
        OUTPUT_REORDER_INPUT_HANDLE_ID,
      );
      if (incomingEdges.length !== 1) {
        return null;
      }

      const [incomingEdge] = incomingEdges;
      if (!incomingEdge) {
        return null;
      }

      const value = resolveNodePlan(
        context,
        incomingEdge.source,
        nextPath,
        incomingEdge.sourceHandle,
      );
      return value?.type === node.valueType ? value : null;
    }
    case "prompt":
      return resolvePromptPlan(context, node, nextPath);
    case "imageGenerator":
    case "videoGenerator":
    case "llmGenerator": {
      const storedOutput = getWorkflowGeneratorOutputRuntimeValue(node);
      if (storedOutput && !context.targetNodeIdSet.has(node.id)) {
        return {
          outputCount: storedOutput.items.length,
          mismatched: false,
          type: storedOutput.type,
        };
      }

      const awaitingReviewOutput =
        getWorkflowGeneratorAwaitingReviewRuntimeValue(node);
      const reviewOutputCount = getReviewOutputCount(node);
      if (awaitingReviewOutput && !context.targetNodeIdSet.has(node.id)) {
        context.reviewBarrierNodeIds.add(node.id);
        return {
          outputCount: Math.max(
            awaitingReviewOutput.items.length,
            reviewOutputCount,
          ),
          mismatched: false,
          type: awaitingReviewOutput.type,
        };
      }

      const info = planGeneratorNode(context, node, nextPath);
      return {
        outputCount: info.iterations,
        mismatched: info.mismatchedIterators,
        type: outputType,
      };
    }
  }
}

function buildPlan(
  document: WorkflowDocument,
  targetNodeIds: readonly string[],
) {
  const context: PlanningContext = {
    document,
    executableNodeIds: [],
    generatorIterationById: new Map(),
    incomingByTarget: buildIncomingByTarget(document.edges),
    nodeMap: new Map(document.nodes.map((node) => [node.id, node])),
    reviewBarrierNodeIds: new Set(),
    requiredNodeIds: new Set(),
    targetNodeIdSet: new Set(targetNodeIds),
  };

  for (const targetNodeId of targetNodeIds) {
    resolveNodePlan(context, targetNodeId, new Set());
  }

  return {
    targetNodeIds: [...targetNodeIds],
    requiredNodeIds: context.requiredNodeIds,
    executableNodeIds: context.executableNodeIds,
    reviewBarrierNodeIds: Array.from(context.reviewBarrierNodeIds),
    generatorIterationById: context.generatorIterationById,
  } satisfies TaskRunMaterializationPlan;
}

function getPlannedOutputCount(params: {
  document: WorkflowDocument;
  generatorIterationById?: ReadonlyMap<string, { iterations: number }>;
  nodeId: string;
  sourceHandleId?: string | null;
}) {
  const seededGeneratorIterations = new Map(
    Array.from(params.generatorIterationById ?? new Map(), ([id, info]) => [
      id,
      {
        hasIterator: info.iterations > 1,
        iterations: info.iterations,
        mismatchedIterators: false,
      } satisfies GeneratorIterationInfo,
    ]),
  );
  const context: PlanningContext = {
    document: params.document,
    executableNodeIds: [],
    generatorIterationById: seededGeneratorIterations,
    incomingByTarget: buildIncomingByTarget(params.document.edges),
    nodeMap: new Map(params.document.nodes.map((node) => [node.id, node])),
    reviewBarrierNodeIds: new Set(),
    requiredNodeIds: new Set(),
    targetNodeIdSet: new Set([params.nodeId]),
  };

  return (
    resolveNodePlan(context, params.nodeId, new Set(), params.sourceHandleId)
      ?.outputCount ?? 1
  );
}

function extractSubgraph(
  document: WorkflowDocument,
  requiredNodeIds: ReadonlySet<string>,
) {
  return {
    ...document,
    nodes: document.nodes.filter((node) => requiredNodeIds.has(node.id)),
    edges: document.edges.filter(
      (edge) =>
        requiredNodeIds.has(edge.source) && requiredNodeIds.has(edge.target),
    ),
  } satisfies WorkflowDocument;
}

export function planTaskRunMaterialization(params: {
  document: WorkflowDocument;
  targetNodeIds: readonly string[];
}) {
  const plan = buildPlan(params.document, params.targetNodeIds);
  validateTargetNodes(params.document, plan.targetNodeIds);
  return {
    ...plan,
    artifactNodeIds: Array.from(
      new Set([...plan.executableNodeIds, ...plan.reviewBarrierNodeIds]),
    ),
    getOutputCount: (nodeId: string, sourceHandleId?: string | null) =>
      getPlannedOutputCount({
        document: params.document,
        generatorIterationById: plan.generatorIterationById,
        nodeId,
        sourceHandleId,
      }),
  };
}

export function extractTaskRunMaterializationSubgraph(
  document: WorkflowDocument,
  targetNodeIds: readonly string[],
) {
  return extractSubgraph(
    document,
    buildPlan(document, targetNodeIds).requiredNodeIds,
  );
}

export function getGeneratorIterationPreview(
  document: WorkflowDocument,
  targetId: string,
) {
  return (
    buildPlan(document, [targetId]).generatorIterationById.get(targetId) ??
    DEFAULT_GENERATOR_ITERATION_INFO
  );
}

export function planTargetNodes(
  document: WorkflowDocument,
  targetNodeIds: readonly string[],
) {
  return buildPlan(document, targetNodeIds);
}
