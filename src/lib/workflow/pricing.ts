import type {
  WorkflowDocument,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import {
  type GeneratorIterationInfo,
  toWorkflowValidationError,
  WorkflowExecutionPlanner,
  WorkflowExecutionPlanningError,
} from "~/lib/workflow/execution/planning";
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
  completedOutputKeys?: ReadonlySet<string>;
};

function buildWorkflowExecutionPriceLineItem(
  node: WorkflowDocumentNode,
  iterationInfo: GeneratorIterationInfo,
  completedOutputKeys: ReadonlySet<string> | undefined,
): WorkflowExecutionPriceLineItem | null {
  const plannedIterations = Math.max(1, iterationInfo.iterations);
  const iterations = completedOutputKeys
    ? Array.from({ length: plannedIterations }).filter(
        (_, outputIndex) =>
          !completedOutputKeys.has(`${node.id}:${outputIndex}`),
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

function buildWorkflowExecutionPriceQuote(
  document: WorkflowDocument,
  executionPlan: ReturnType<typeof WorkflowExecutionPlanner.forQuote>,
  options?: WorkflowExecutionEstimateOptions,
): WorkflowExecutionPriceQuote {
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const lineItems = executionPlan.priceNodeIds
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
              options?.completedOutputKeys,
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
  try {
    return buildWorkflowExecutionPriceQuote(
      request.document,
      WorkflowExecutionPlanner.forQuote({
        document: request.document,
        selectionNodeIds: request.selection?.nodeIds ?? [],
        target: request.target,
      }),
      options,
    );
  } catch (error) {
    if (error instanceof WorkflowExecutionPlanningError) {
      throw toWorkflowValidationError(error);
    }
    throw error;
  }
}
