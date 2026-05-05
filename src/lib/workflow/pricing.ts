import type {
  WorkflowDocument,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import type { StartWorkflowExecutionRequest } from "~/lib/workflow/execution/types";
import {
  getImageGeneratorModelCreditCost,
  getVideoGeneratorModelCreditCost,
} from "~/lib/workflow/generator-models";
import {
  calculateLlmUsageCreditCost,
  LLM_ESTIMATED_CREDIT_COST,
} from "~/lib/workflow/llm-models";
import type {
  GenerateImageRequest,
  GenerateLlmResponse,
  GenerateVideoRequest,
} from "~/lib/workflow/types";
import { materializeWorkflowRunTaskFacts } from "~/lib/workflow-runtime/materialization/task-run-input-materialization";

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

export type WorkflowRuntimeEstimatedCreditCostByNodeId = Readonly<
  Record<string, number>
>;

type WorkflowExecutionEstimateOptions = {
  completedOutputKeys?: ReadonlySet<string>;
};

export type WorkflowRuntimeCreditEstimateCommand =
  | { readonly type: "run-node"; readonly nodeId: string }
  | {
      readonly type: "run-task-slot";
      readonly nodeExecutionId: string;
      readonly itemIndex: number;
    };

export type WorkflowRuntimeCreditEstimateNodeExecution = {
  readonly id: string;
  readonly nodeId: string;
};

function buildWorkflowExecutionPriceLineItem(
  node: WorkflowDocumentNode,
  plannedIterations: number,
  completedOutputKeys: ReadonlySet<string> | undefined,
): WorkflowExecutionPriceLineItem | null {
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
  iterationCountByNodeId: ReadonlyMap<string, number>,
  options?: WorkflowExecutionEstimateOptions,
): WorkflowExecutionPriceQuote {
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const lineItems = Array.from(iterationCountByNodeId.keys())
    .map((nodeId) => nodeMap.get(nodeId))
    .flatMap((node) =>
      node
        ? [
            buildWorkflowExecutionPriceLineItem(
              node,
              Math.max(1, iterationCountByNodeId.get(node.id) ?? 1),
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

export function priceLlmGeneration(
  response: Pick<GenerateLlmResponse, "model" | "usage">,
) {
  return calculateLlmUsageCreditCost(response);
}

export function priceVideoGeneration(request: GenerateVideoRequest) {
  return getVideoGeneratorModelCreditCost(request.model);
}

export function estimateWorkflowRuntimeNodeCreditCost(
  node: WorkflowDocumentNode,
) {
  switch (node.kind) {
    case "imageGenerator":
      return getImageGeneratorModelCreditCost(node.model);
    case "videoGenerator":
      return getVideoGeneratorModelCreditCost(node.model);
    case "llmGenerator":
      return LLM_ESTIMATED_CREDIT_COST;
    default:
      return 0;
  }
}

export function estimateWorkflowRuntimeCreditCostByNodeId(input: {
  readonly document: WorkflowDocument;
  readonly overrides?: WorkflowRuntimeEstimatedCreditCostByNodeId;
}): WorkflowRuntimeEstimatedCreditCostByNodeId {
  return Object.fromEntries(
    input.document.nodes.map((node) => [
      node.id,
      input.overrides?.[node.id] ?? estimateWorkflowRuntimeNodeCreditCost(node),
    ]),
  );
}

export function estimateWorkflowRuntimeCommand(input: {
  readonly command: WorkflowRuntimeCreditEstimateCommand;
  readonly document: WorkflowDocument;
  readonly latestNodeExecutions?: readonly WorkflowRuntimeCreditEstimateNodeExecution[];
  readonly options?: WorkflowExecutionEstimateOptions;
}): WorkflowExecutionPriceQuote {
  const targetNodeIds = resolveCreditEstimateTargetNodeIds(input);
  const facts = materializeWorkflowRunTaskFacts({
    document: input.document,
    targetNodeIds,
  });
  if (!facts.ok) {
    throw new WorkflowValidationError({ message: facts.error.message });
  }

  const quotedNodeIds = facts.value.executableNodeIds;
  const quotedNodeIdSet = new Set(quotedNodeIds);
  const selectedItemIndex =
    input.command.type === "run-task-slot" ? input.command.itemIndex : null;
  const iterationCountByNodeId = new Map<string, number>();

  for (const fact of facts.value.taskFacts) {
    if (!quotedNodeIdSet.has(fact.nodeId)) {
      continue;
    }
    if (selectedItemIndex !== null && selectedItemIndex !== fact.itemIndex) {
      continue;
    }
    iterationCountByNodeId.set(
      fact.nodeId,
      (iterationCountByNodeId.get(fact.nodeId) ?? 0) + 1,
    );
  }

  return buildWorkflowExecutionPriceQuote(
    input.document,
    iterationCountByNodeId,
    input.options,
  );
}

function resolveCreditEstimateTargetNodeIds(input: {
  readonly command: WorkflowRuntimeCreditEstimateCommand;
  readonly latestNodeExecutions?: readonly WorkflowRuntimeCreditEstimateNodeExecution[];
}) {
  switch (input.command.type) {
    case "run-node":
      return [input.command.nodeId];
    case "run-task-slot": {
      const nodeExecutionId = input.command.nodeExecutionId;
      const nodeExecution = input.latestNodeExecutions?.find(
        (execution) => execution.id === nodeExecutionId,
      );
      if (!nodeExecution) {
        throw new WorkflowValidationError({
          message: `Cannot estimate Task Run slot execution for missing Node Execution ${nodeExecutionId}.`,
        });
      }
      return [nodeExecution.nodeId];
    }
  }
}

export function estimateWorkflowExecution(
  request: StartWorkflowExecutionRequest,
  options?: WorkflowExecutionEstimateOptions,
): WorkflowExecutionPriceQuote {
  return estimateWorkflowRuntimeCommand({
    command: { nodeId: request.target.nodeId, type: "run-node" },
    document: request.document,
    options,
  });
}
