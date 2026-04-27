import type { WorkflowDocument } from "~/lib/workflow/document";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import {
  replaceMediaOutputLanes,
  replaceTextOutputLanes,
} from "~/lib/workflow/execution/output-lanes";
import {
  ImageGeneratorService,
  LlmGeneratorService,
  VideoGeneratorService,
} from "~/lib/workflow/services/node-services";
import type { WorkflowReviewState } from "~/lib/workflow/types";

function mergeReviewState(
  currentReview: WorkflowReviewState,
  executionReview: WorkflowReviewState,
  laneIndex: number | null | undefined,
) {
  if (laneIndex === null || laneIndex === undefined) {
    return executionReview;
  }

  const currentLanes =
    currentReview.sourceNodeId === executionReview.sourceNodeId &&
    currentReview.valueType === executionReview.valueType
      ? currentReview.lanes
      : [];

  const currentByIndex = new Map(
    currentLanes.map((lane) => [lane.laneIndex, lane]),
  );
  const executionByIndex = new Map(
    executionReview.lanes.map((lane) => [lane.laneIndex, lane]),
  );
  const executionLane = executionByIndex.get(laneIndex);

  return {
    ...executionReview,
    lanes: Array.from(
      new Set([
        ...currentByIndex.keys(),
        ...(executionLane ? [laneIndex] : []),
      ]),
    )
      .sort((left, right) => left - right)
      .flatMap((index) => {
        const lane =
          index === laneIndex ? executionLane : currentByIndex.get(index);
        return lane ? [lane] : [];
      }),
    updatedAt: executionReview.updatedAt ?? currentReview.updatedAt,
  } satisfies WorkflowReviewState;
}

function hasPersistableExecutionState(node: WorkflowDocument["nodes"][number]) {
  return (
    (node.kind === "imageGenerator" && node.outputLanes.length > 0) ||
    (node.kind === "videoGenerator" && node.outputLanes.length > 0) ||
    (node.kind === "llmGenerator" && node.outputLanes.length > 0)
  );
}

export function mergeWorkflowExecutionDocument(params: {
  currentDocument: WorkflowDocument;
  executionDocument: WorkflowDocument;
  mergeExecutionLaneIndex?: number | null;
  targetNodeIds: string[];
}) {
  const executionNodeById = new Map(
    params.executionDocument.nodes.map((node) => [node.id, node]),
  );
  const targetNodeIds = new Set(params.targetNodeIds);

  return {
    ...params.currentDocument,
    nodes: params.currentDocument.nodes.map((node) => {
      const executionNode = executionNodeById.get(node.id);
      if (!targetNodeIds.has(node.id) && !executionNode) {
        return node;
      }

      if (!targetNodeIds.has(node.id) && executionNode) {
        if (
          node.kind !== executionNode.kind ||
          !hasPersistableExecutionState(executionNode)
        ) {
          return node;
        }
      }

      if (!executionNode) {
        throw new WorkflowValidationError({
          message: `Execution result for node ${node.id} is missing.`,
        });
      }

      if (node.kind !== executionNode.kind) {
        throw new WorkflowValidationError({
          message: `Execution result for node ${node.id} has an incompatible type.`,
        });
      }

      if (
        node.kind === "imageGenerator" &&
        executionNode.kind === "imageGenerator"
      ) {
        const outputLanes = replaceMediaOutputLanes(
          node.outputLanes,
          executionNode.outputLanes,
          params.mergeExecutionLaneIndex,
        );
        return {
          ...ImageGeneratorService.setExecutionResult(node, {
            lastPrompt: executionNode.lastPrompt,
            outputAssets: outputLanes.flat(),
            outputLanes,
            responseText: executionNode.responseText,
          }),
          review: mergeReviewState(
            node.review,
            executionNode.review,
            params.mergeExecutionLaneIndex,
          ),
          reviewEnabled: executionNode.reviewEnabled,
        } satisfies typeof node;
      }

      if (
        node.kind === "videoGenerator" &&
        executionNode.kind === "videoGenerator"
      ) {
        const outputLanes = replaceMediaOutputLanes(
          node.outputLanes,
          executionNode.outputLanes,
          params.mergeExecutionLaneIndex,
        );
        return {
          ...VideoGeneratorService.setExecutionResult(node, {
            lastPrompt: executionNode.lastPrompt,
            outputAssets: outputLanes.flat(),
            outputLanes,
            responseText: executionNode.responseText,
          }),
          review: mergeReviewState(
            node.review,
            executionNode.review,
            params.mergeExecutionLaneIndex,
          ),
          reviewEnabled: executionNode.reviewEnabled,
        } satisfies typeof node;
      }

      if (
        node.kind === "llmGenerator" &&
        executionNode.kind === "llmGenerator"
      ) {
        const outputLanes = replaceTextOutputLanes(
          node.outputLanes,
          executionNode.outputLanes,
          params.mergeExecutionLaneIndex,
        );
        return {
          ...LlmGeneratorService.setExecutionResult(node, {
            lastPrompt: executionNode.lastPrompt,
            lastSystemPrompt: executionNode.lastSystemPrompt,
            outputLanes,
            responseText: outputLanes.filter(Boolean).join("\n\n") || null,
          }),
          review: mergeReviewState(
            node.review,
            executionNode.review,
            params.mergeExecutionLaneIndex,
          ),
          reviewEnabled: executionNode.reviewEnabled,
        } satisfies typeof node;
      }

      throw new WorkflowValidationError({
        message: `Node ${node.id} is not a persistable execution target.`,
      });
    }),
  } satisfies WorkflowDocument;
}
