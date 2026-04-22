import type {
  WorkflowDocument,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import { resolveWorkflowExecutionTargets } from "~/lib/workflow/execution/target-resolution";
import type { StartWorkflowExecutionRequest } from "~/lib/workflow/execution/types";
import {
  getImageGeneratorModelCreditCost,
  getVideoGeneratorModelCreditCost,
} from "~/lib/workflow/generator-models";
import {
  buildLlmGenerationRequest,
  calculateLlmRequestEstimateCreditCost,
  SYSTEM_PROMPT_INPUT_HANDLE_ID,
} from "~/lib/workflow/llm-models";
import {
  buildGeneratorAssetBatchPlan,
  buildIncomingByTarget,
  getGeneratorMediaValuesByHandle,
  getGeneratorIterationPreview,
  getIncomingEdgesForHandle,
  getWorkflowNodeRuntimeValue,
} from "~/lib/workflow/graph";
import { PROMPT_INPUT_HANDLE_ID } from "~/lib/workflow/node-definitions";
import type {
  GenerateImageRequest,
  GenerateVideoRequest,
} from "~/lib/workflow/types";
import { isGeneratorNodeKind } from "~/lib/workflow/types";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";

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

function collectExecutableGeneratorNodeIds(
  document: WorkflowDocument,
  targetIds: string[],
) {
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const incomingByTarget = buildIncomingByTarget(document.edges);
  const executableGeneratorNodeIds = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeId: string) => {
    if (visited.has(nodeId)) {
      return;
    }

    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) {
      return;
    }

    if (isGeneratorNodeKind(node.kind)) {
      executableGeneratorNodeIds.add(node.id);
    }

    for (const edge of incomingByTarget.get(nodeId) ?? []) {
      visit(edge.source);
    }
  };

  for (const targetId of targetIds) {
    visit(targetId);
  }

  return [...executableGeneratorNodeIds];
}

function getQuotedTextInput(params: {
  document: WorkflowDocument;
  handleId: string;
  targetId: string;
}) {
  const nodeMap = new Map(params.document.nodes.map((node) => [node.id, node]));
  const incomingByTarget = buildIncomingByTarget(params.document.edges);

  return getIncomingEdgesForHandle(
    incomingByTarget,
    params.targetId,
    params.handleId,
  )
    .flatMap((edge) => {
      const sourceNode = nodeMap.get(edge.source);
      const runtimeValue = sourceNode
        ? getWorkflowNodeRuntimeValue(sourceNode)
        : null;

      if (!runtimeValue || runtimeValue.type !== "text") {
        return [];
      }

      const text = runtimeValue.text.trim();
      return text ? [text] : [];
    })
    .join("\n\n");
}

function buildWorkflowExecutionPriceLineItem(
  document: WorkflowDocument,
  node: WorkflowDocumentNode,
): WorkflowExecutionPriceLineItem | null {
  const iterations = Math.max(
    1,
    getGeneratorIterationPreview(document, node.id).iterations,
  );

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
      const prompt =
        getQuotedTextInput({
          document,
          handleId: PROMPT_INPUT_HANDLE_ID,
          targetId: node.id,
        }) || "Pending upstream LLM output.";
      const systemPrompt = getQuotedTextInput({
        document,
        handleId: SYSTEM_PROMPT_INPUT_HANDLE_ID,
        targetId: node.id,
      });
      const batchPlan = buildGeneratorAssetBatchPlan(
        getGeneratorMediaValuesByHandle(document, node.id, "image"),
      );
      const totalCost = batchPlan.batches.reduce(
        (sum, imageInputsByHandle) =>
          sum +
          calculateLlmRequestEstimateCreditCost(
            buildLlmGenerationRequest({
              imageInputsByHandle,
              prompt,
              settings: node,
              systemPrompt: systemPrompt || null,
            }),
          ),
        0,
      );

      return {
        nodeId: node.id,
        kind: node.kind,
        iterations: batchPlan.iterations,
        costPerIteration: Math.max(
          1,
          Math.ceil(totalCost / Math.max(1, batchPlan.iterations)),
        ),
        isEstimate: true,
        totalCost,
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
): WorkflowExecutionPriceQuote {
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const lineItems = collectExecutableGeneratorNodeIds(document, targetIds)
    .map((nodeId) => nodeMap.get(nodeId))
    .flatMap((node) =>
      node ? [buildWorkflowExecutionPriceLineItem(document, node)] : [],
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
): WorkflowExecutionPriceQuote {
  const targetIds = resolveQuotedTargetIds(request);
  return buildWorkflowExecutionPriceQuote(request.document, targetIds);
}

export function quoteWorkflowExecution(
  request: StartWorkflowExecutionRequest,
): WorkflowExecutionPriceQuote {
  const targetIds = resolveQuotedTargetIds(request);

  WorkflowGraphValidator.validateQuoteTargets(request.document, targetIds);

  return buildWorkflowExecutionPriceQuote(request.document, targetIds);
}
