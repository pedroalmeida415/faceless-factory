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
  buildIncomingByTarget,
  getGeneratorIterationPreview,
} from "~/lib/workflow/graph";
import type {
  GenerateImageRequest,
  GenerateVideoRequest,
} from "~/lib/workflow/types";
import { isGeneratorNodeKind } from "~/lib/workflow/types";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";

export type WorkflowExecutionPriceLineItem = {
  nodeId: string;
  kind: "imageGenerator" | "videoGenerator";
  iterations: number;
  costPerIteration: number;
  totalCost: number;
};

export type WorkflowExecutionPriceQuote = {
  totalCost: number;
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
        totalCost: costPerIteration * iterations,
      };
    }
    default:
      return null;
  }
}

export function priceImageGeneration(request: GenerateImageRequest) {
  return getImageGeneratorModelCreditCost(request.model);
}

export function priceVideoGeneration(request: GenerateVideoRequest) {
  return getVideoGeneratorModelCreditCost(request.model);
}

export function quoteWorkflowExecution(
  request: StartWorkflowExecutionRequest,
): WorkflowExecutionPriceQuote {
  const targetIds = resolveWorkflowExecutionTargets(
    request.document,
    request.selection?.nodeIds ?? [],
    request.target,
  );

  if (!targetIds.length) {
    throw new WorkflowValidationError({
      message: "Add an image or video generator first.",
    });
  }

  WorkflowGraphValidator.validateExecutionTargets(request.document, targetIds);

  const nodeMap = new Map(
    request.document.nodes.map((node) => [node.id, node]),
  );
  const lineItems = collectExecutableGeneratorNodeIds(
    request.document,
    targetIds,
  )
    .map((nodeId) => nodeMap.get(nodeId))
    .flatMap((node) =>
      node ? [buildWorkflowExecutionPriceLineItem(request.document, node)] : [],
    )
    .filter(
      (lineItem): lineItem is WorkflowExecutionPriceLineItem =>
        lineItem !== null,
    );

  return {
    totalCost: lineItems.reduce(
      (totalCost, lineItem) => totalCost + lineItem.totalCost,
      0,
    ),
    lineItems,
  };
}
