import type { WorkflowDocument } from "~/lib/workflow/document";
import {
  buildIncomingByTarget,
  getAlignedLaneCount,
  getGeneratorInputHandles,
  getIncomingEdgesForHandle,
  getPromptNodeReferencedVariableKeys,
  getWorkflowGeneratorOutputRuntimeValue,
} from "~/lib/workflow/graph";
import {
  PROMPT_VARIABLE_PATTERN,
  type WorkflowValueType,
} from "~/lib/workflow/node-definitions";

export type GeneratorIterationInfo = {
  hasIterator: boolean;
  iterations: number;
  mismatchedIterators: boolean;
};

type PlannedValue = {
  type: WorkflowValueType;
  laneCount: number;
  mismatched: boolean;
};

type PlanningContext = {
  document: WorkflowDocument;
  executableNodeIds: string[];
  generatorIterationById: Map<string, GeneratorIterationInfo>;
  incomingByTarget: ReturnType<typeof buildIncomingByTarget>;
  nodeMap: Map<string, WorkflowDocument["nodes"][number]>;
  requiredNodeIds: Set<string>;
  targetNodeIdSet: Set<string>;
};

export type WorkflowExecutionPlan = {
  targetNodeIds: string[];
  requiredNodeIds: Set<string>;
  executableNodeIds: string[];
  generatorIterationById: Map<string, GeneratorIterationInfo>;
};

const DEFAULT_GENERATOR_ITERATION_INFO: GeneratorIterationInfo = {
  hasIterator: false,
  iterations: 1,
  mismatchedIterators: false,
};

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
    case "imageGenerator":
      return "image";
    case "videoGenerator":
      return "video";
  }
}

function toGeneratorIterationInfo(
  values: readonly PlannedValue[],
): GeneratorIterationInfo {
  const laneCounts = values.map((value) => value.laneCount);
  const hasNestedMismatch = values.some((value) => value.mismatched);

  if (!laneCounts.length) {
    return DEFAULT_GENERATOR_ITERATION_INFO;
  }

  try {
    const iterations = getAlignedLaneCount(laneCounts);
    return {
      hasIterator: iterations > 1,
      iterations,
      mismatchedIterators: hasNestedMismatch,
    };
  } catch {
    return {
      hasIterator: true,
      iterations: Math.max(...laneCounts),
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
    laneCount: info.iterations,
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
      .map((edge) => resolveNodePlan(context, edge.source, path))
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
      ? { laneCount: 1, mismatched: false, type: "text" }
      : null;
  }

  const info = toGeneratorIterationInfo(variableValues);
  return {
    type: "text",
    laneCount: info.iterations,
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
      .map((edge) => resolveNodePlan(context, edge.source, path))
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

  const info = toGeneratorIterationInfo(
    resolveGeneratorInputPlans(context, node.id, path),
  );
  context.generatorIterationById.set(node.id, info);
  return info;
}

function resolveNodePlan(
  context: PlanningContext,
  nodeId: string,
  path: ReadonlySet<string>,
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
      const laneCount = node.items.filter((item) => item.trim()).length;
      return laneCount ? { laneCount, mismatched: false, type: "text" } : null;
    }
    case "asset":
      return node.assetKind && node.assets.length
        ? {
            laneCount: node.assets.length,
            mismatched: false,
            type: node.assetKind,
          }
        : null;
    case "prompt":
      return resolvePromptPlan(context, node, nextPath);
    case "imageGenerator":
    case "videoGenerator":
    case "llmGenerator": {
      const storedOutput = getWorkflowGeneratorOutputRuntimeValue(node);
      if (storedOutput && !context.targetNodeIdSet.has(node.id)) {
        return {
          laneCount: storedOutput.lanes.length,
          mismatched: false,
          type: storedOutput.type,
        };
      }

      const info = planGeneratorNode(context, node, nextPath);
      return {
        laneCount: info.iterations,
        mismatched: info.mismatchedIterators,
        type: outputType,
      };
    }
  }
}

export function buildWorkflowExecutionPlan(
  document: WorkflowDocument,
  targetNodeIds: string[],
): WorkflowExecutionPlan {
  const context: PlanningContext = {
    document,
    executableNodeIds: [],
    generatorIterationById: new Map(),
    incomingByTarget: buildIncomingByTarget(document.edges),
    nodeMap: new Map(document.nodes.map((node) => [node.id, node])),
    requiredNodeIds: new Set(),
    targetNodeIdSet: new Set(targetNodeIds),
  };

  for (const targetNodeId of targetNodeIds) {
    resolveNodePlan(context, targetNodeId, new Set());
  }

  return {
    targetNodeIds,
    requiredNodeIds: context.requiredNodeIds,
    executableNodeIds: context.executableNodeIds,
    generatorIterationById: context.generatorIterationById,
  };
}

export function getGeneratorIterationPreview(
  document: WorkflowDocument,
  targetId: string,
): GeneratorIterationInfo {
  return (
    buildWorkflowExecutionPlan(document, [targetId]).generatorIterationById.get(
      targetId,
    ) ?? DEFAULT_GENERATOR_ITERATION_INFO
  );
}

export function collectWorkflowExecutionNodeIds(
  document: WorkflowDocument,
  targetNodeIds: string[],
) {
  return buildWorkflowExecutionPlan(document, targetNodeIds).requiredNodeIds;
}

export function extractWorkflowExecutionSubgraph(
  document: WorkflowDocument,
  targetNodeIds: string[],
): WorkflowDocument {
  const requiredNodeIds = collectWorkflowExecutionNodeIds(
    document,
    targetNodeIds,
  );

  return {
    ...document,
    nodes: document.nodes.filter((node) => requiredNodeIds.has(node.id)),
    edges: document.edges.filter(
      (edge) =>
        requiredNodeIds.has(edge.source) && requiredNodeIds.has(edge.target),
    ),
  };
}

export function collectExecutableWorkflowGeneratorNodeIds(
  document: WorkflowDocument,
  targetNodeIds: string[],
) {
  return buildWorkflowExecutionPlan(document, targetNodeIds).executableNodeIds;
}
