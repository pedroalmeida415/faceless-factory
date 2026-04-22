import { Effect } from "effect";

import type {
  WorkflowDocument,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import {
  WorkflowAuthorizationError,
  type WorkflowConfigError,
  type WorkflowGenerationError,
  type WorkflowStorageError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import { resolveWorkflowExecutionTargets } from "~/lib/workflow/execution/target-resolution";
import type { StartWorkflowExecutionRequest } from "~/lib/workflow/execution/types";
import {
  getImageGeneratorModelCreditCost,
  getVideoGeneratorModelCreditCost,
} from "~/lib/workflow/generator-models";
import {
  buildGeneratorAssetBatchPlan,
  buildIncomingByTarget,
  getGeneratorIterationPreview,
  getGeneratorMediaValuesByHandle,
  getIncomingEdgesForHandle,
  getWorkflowNodeRuntimeValue,
} from "~/lib/workflow/graph";
import {
  buildLlmGenerationRequest,
  calculateLlmEstimateCreditCost,
  SYSTEM_PROMPT_INPUT_HANDLE_ID,
} from "~/lib/workflow/llm-models";
import { PROMPT_INPUT_HANDLE_ID } from "~/lib/workflow/node-definitions";
import {
  estimateWorkflowExecution,
  priceImageGeneration,
  priceVideoGeneration,
  type WorkflowExecutionPriceLineItem,
  type WorkflowExecutionPriceQuote,
} from "~/lib/workflow/pricing";
import type { GenerateLlmRequest } from "~/lib/workflow/types";
import { isGeneratorNodeKind } from "~/lib/workflow/types";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";
import { assertWorkflowProjectAccess } from "~/server/workflow/projects";

type LlmTokenCounter = {
  countTokensForGemini3Flash: (params: {
    ownerUserId: string;
    request: GenerateLlmRequest;
  }) => Effect.Effect<
    { totalTokens: number },
    | WorkflowAuthorizationError
    | WorkflowConfigError
    | WorkflowGenerationError
    | WorkflowStorageError
    | WorkflowValidationError
  >;
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

function buildFixedPriceLineItem(
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
        isEstimate: false,
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
        isEstimate: false,
      };
    }
    default:
      return null;
  }
}

function buildLlmEstimateLineItem(params: {
  document: WorkflowDocument;
  node: Extract<WorkflowDocumentNode, { kind: "llmGenerator" }>;
  userId: string;
  vertexAi: LlmTokenCounter;
}) {
  return Effect.gen(function* () {
    const prompt =
      getQuotedTextInput({
        document: params.document,
        handleId: PROMPT_INPUT_HANDLE_ID,
        targetId: params.node.id,
      }) || "Pending upstream LLM output.";

    const systemPrompt = getQuotedTextInput({
      document: params.document,
      handleId: SYSTEM_PROMPT_INPUT_HANDLE_ID,
      targetId: params.node.id,
    });
    const batchPlan = buildGeneratorAssetBatchPlan(
      getGeneratorMediaValuesByHandle(params.document, params.node.id, "image"),
    );
    const tokenCounts = yield* Effect.forEach(
      batchPlan.batches,
      (imageInputsByHandle) =>
        params.vertexAi.countTokensForGemini3Flash({
          ownerUserId: params.userId,
          request: buildLlmGenerationRequest({
            imageInputsByHandle,
            prompt,
            settings: params.node,
            systemPrompt: systemPrompt || null,
          }),
        }),
      {
        concurrency: "unbounded",
      },
    );
    const maxOutputTokens =
      typeof params.node.config.maxOutputTokens === "number"
        ? params.node.config.maxOutputTokens
        : 2048;
    const totalCost = tokenCounts.reduce(
      (sum, tokenCount) =>
        sum +
        calculateLlmEstimateCreditCost({
          estimatedInputTokens: tokenCount.totalTokens,
          maxOutputTokens,
          model: params.node.model,
        }),
      0,
    );

    return {
      nodeId: params.node.id,
      kind: params.node.kind,
      iterations: batchPlan.iterations,
      costPerIteration: Math.max(
        1,
        Math.ceil(totalCost / Math.max(1, batchPlan.iterations)),
      ),
      totalCost,
      isEstimate: true,
    } satisfies WorkflowExecutionPriceLineItem;
  });
}

export function quoteWorkflowExecution(params: {
  request: StartWorkflowExecutionRequest;
  userId: string;
  vertexAi: LlmTokenCounter;
}) {
  return Effect.gen(function* () {
    const projectId = params.request.projectId?.trim();
    if (!projectId) {
      return yield* Effect.fail(
        new WorkflowValidationError({
          message: "A workflow project is required to quote execution.",
        }),
      );
    }

    yield* Effect.tryPromise({
      try: () =>
        assertWorkflowProjectAccess({
          ownerUserId: params.userId,
          projectId,
        }),
      catch: (cause) =>
        cause instanceof WorkflowAuthorizationError ||
        cause instanceof WorkflowValidationError
          ? cause
          : new WorkflowValidationError({
              message: "Failed to quote workflow execution.",
              cause,
            }),
    });

    const targetIds = resolveQuotedTargetIds(params.request);
    WorkflowGraphValidator.validateExecutionTargets(
      params.request.document,
      targetIds,
    );

    const nodeMap = new Map(
      params.request.document.nodes.map((node) => [node.id, node]),
    );
    const lineItems = yield* Effect.forEach(
      collectExecutableGeneratorNodeIds(params.request.document, targetIds),
      (nodeId) => {
        const node = nodeMap.get(nodeId);
        if (!node) {
          return Effect.succeed(null);
        }

        if (node.kind === "llmGenerator") {
          return buildLlmEstimateLineItem({
            document: params.request.document,
            node,
            userId: params.userId,
            vertexAi: params.vertexAi,
          }).pipe(
            Effect.map(
              (lineItem) => lineItem as WorkflowExecutionPriceLineItem,
            ),
          );
        }

        return Effect.succeed(
          buildFixedPriceLineItem(params.request.document, node),
        );
      },
      {
        concurrency: "unbounded",
      },
    ).pipe(
      Effect.map((items) =>
        items.filter(
          (lineItem): lineItem is WorkflowExecutionPriceLineItem =>
            lineItem !== null,
        ),
      ),
    );

    return {
      hasEstimate: lineItems.some((lineItem) => lineItem.isEstimate),
      totalCost: lineItems.reduce(
        (totalCost, lineItem) => totalCost + lineItem.totalCost,
        0,
      ),
      lineItems,
    } satisfies WorkflowExecutionPriceQuote;
  });
}

export {
  estimateWorkflowExecution,
  priceImageGeneration,
  priceVideoGeneration,
  type WorkflowExecutionPriceLineItem,
  type WorkflowExecutionPriceQuote,
};
