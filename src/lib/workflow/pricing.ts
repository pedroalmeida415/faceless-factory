import type {
  WorkflowDocument,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import {
  buildWorkflowExecutionPlan,
  type GeneratorIterationInfo,
} from "~/lib/workflow/execution/subgraph";
import { resolveWorkflowExecutionTargets } from "~/lib/workflow/execution/target-resolution";
import type { StartWorkflowExecutionRequest } from "~/lib/workflow/execution/types";
import {
  getImageGeneratorModelCreditCost,
  getVideoGeneratorModelCreditCost,
} from "~/lib/workflow/generator-models";
import { LLM_ESTIMATED_CREDIT_COST } from "~/lib/workflow/llm-models";
import type {
  GenerateImageRequest,
  GenerateVideoRequest,
} from "~/lib/workflow/types";

export type WorkflowExecutionPriceLineItem = {
  nodeId: string;
  kind: "imageGenerator" | "videoGenerator" | "llmGenerator";
  iterations: number;
  costPerIteration: number;
  totalCost: number;
  isEstimate: boolean;
};

export type WorkflowExecutionPriceQuote = {
  totalCost: number;
  hasEstimate: boolean;
  lineItems: WorkflowExecutionPriceLineItem[];
};

type WorkflowExecutionEstimateOptions = {
  completedLaneKeys?: ReadonlySet<string>;
};

function buildWorkflowExecutionPriceLineItem(
  node: WorkflowDocumentNode,
  iterationInfo: GeneratorIterationInfo,
  completedLaneKeys: ReadonlySet<string> | undefined,
): WorkflowExecutionPriceLineItem | null {
  const plannedIterations = Math.max(1, iterationInfo.iterations);
  const iterations = completedLaneKeys
    ? Array.from({ length: plannedIterations }).filter(
        (_, laneIndex) => !completedLaneKeys.has(`${node.id}:${laneIndex}`),
      ).length
    : plannedIterations;

  if (iterations === 0) {
    return null;
  }

  switch (node.kind) {
    case "imageGenerator": {
      const costPerIteration = getImageGeneratorModelCreditCost(node.model);
      return {
        nodeId: node.id,
        kind: node.kind,
        iterations,
        costPerIteration,
        isEstimate: false,
        totalCost: costPerIteration * iterations,
      };
    }
    case "videoGenerator": {
      const costPerIteration = getVideoGeneratorModelCreditCost(node.model);
      return {
        nodeId: node.id,
        kind: node.kind,
        iterations,
        costPerIteration,
        isEstimate: false,
        totalCost: costPerIteration * iterations,
      };
    }
    case "llmGenerator": {
      return {
        nodeId: node.id,
        kind: node.kind,
        iterations,
        costPerIteration: LLM_ESTIMATED_CREDIT_COST,
        isEstimate: true,
        totalCost: iterations * LLM_ESTIMATED_CREDIT_COST,
      };
    }
    default:
      return null;
  }
}

function resolveQuotedTargetIds(request: StartWorkflowExecutionRequest) {
  const targetIds = resolveWorkflowExecutionTargets(
    request.document,
    request.selection?.nodeIds ?? [],
    request.target,
  );

  if (!targetIds.length) {
    throw new WorkflowValidationError({
      message: "Add a generator first.",
    });
  }

  return targetIds;
}

function buildWorkflowExecutionPriceQuote(
  document: WorkflowDocument,
  targetIds: string[],
  options?: WorkflowExecutionEstimateOptions,
): WorkflowExecutionPriceQuote {
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const executionPlan = buildWorkflowExecutionPlan(document, targetIds);
  const lineItems = executionPlan.executableNodeIds
    .map((nodeId) => nodeMap.get(nodeId))
    .flatMap((node) =>
      node
        ? [
            buildWorkflowExecutionPriceLineItem(
              node,
              executionPlan.generatorIterationById.get(node.id) ?? {
                hasIterator: false,
                iterations: 1,
                mismatchedIterators: false,
              },
              options?.completedLaneKeys,
            ),
          ]
        : [],
    )
    .filter(
      (lineItem): lineItem is WorkflowExecutionPriceLineItem =>
        lineItem !== null,
    );

  return {
    hasEstimate: lineItems.some((lineItem) => lineItem.isEstimate),
    totalCost: lineItems.reduce(
      (totalCost, lineItem) => totalCost + lineItem.totalCost,
      0,
    ),
    lineItems,
  };
}

export function priceImageGeneration(request: GenerateImageRequest) {
  return getImageGeneratorModelCreditCost(request.model);
}

export function priceVideoGeneration(request: GenerateVideoRequest) {
  return getVideoGeneratorModelCreditCost(request.model);
}

export function estimateWorkflowExecution(
  request: StartWorkflowExecutionRequest,
  options?: WorkflowExecutionEstimateOptions,
): WorkflowExecutionPriceQuote {
  const targetIds = resolveQuotedTargetIds(request);
  return buildWorkflowExecutionPriceQuote(request.document, targetIds, options);
}
