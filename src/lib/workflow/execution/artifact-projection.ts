import {
  hydrateWorkflowGraphDocument,
  toWorkflowGraphDocument,
  type WorkflowDocument,
  type WorkflowGraphDocument,
} from "~/lib/workflow/document";
import {
  replaceMediaOutputOutput,
  replaceTextOutputOutput,
} from "~/lib/workflow/execution/node-outputs";
import type {
  NodeOutputArtifact,
  WorkflowOutputArtifacts,
} from "~/lib/workflow/execution/types";
import {
  buildCurrentWorkflowOutputProjection,
  getLatestOutputReviewArtifacts,
  getMaterializedWorkflowOutputs,
  getWorkflowOutputKey,
} from "~/lib/workflow/execution/types";
import {
  ImageGeneratorService,
  LlmGeneratorService,
  VideoGeneratorService,
} from "~/lib/workflow/services/node-services";
import type { WorkflowReviewState } from "~/lib/workflow/types";

function getLatestOutputs(outputs: readonly NodeOutputArtifact[]) {
  const latest = new Map<string, NodeOutputArtifact>();
  for (const output of outputs) {
    const key = getWorkflowOutputKey(output);
    const existing = latest.get(key);
    if (!existing || existing.attempt < output.attempt) {
      latest.set(key, output);
    }
  }
  return latest;
}

function getVisibleLatestOutputs(artifacts: WorkflowOutputArtifacts) {
  return Array.from(buildCurrentWorkflowOutputProjection(artifacts).values())
    .flatMap((slot) => slot.committedOutput ?? [])
    .filter(
      (output) => !output.reviewStatus || output.reviewStatus === "approved",
    );
}

export function getWorkflowVisibleCompletionOutputs(
  artifacts: WorkflowOutputArtifacts,
) {
  return getVisibleLatestOutputs(artifacts);
}

function groupByNodeId<Value extends { nodeId: string }>(
  values: readonly Value[],
) {
  const grouped = new Map<string, Value[]>();
  for (const value of values) {
    grouped.set(value.nodeId, [...(grouped.get(value.nodeId) ?? []), value]);
  }
  return grouped;
}

export function buildWorkflowOutputProjection(params: {
  artifacts: WorkflowOutputArtifacts;
  document: WorkflowDocument | WorkflowGraphDocument;
}) {
  return buildWorkflowArtifactProjection(params);
}

export function buildWorkflowApprovedOutputProjection(params: {
  artifacts: WorkflowOutputArtifacts;
  document: WorkflowDocument | WorkflowGraphDocument;
}) {
  const document =
    hydrateWorkflowGraphDocument(toWorkflowGraphDocument(params.document)) ??
    (params.document as WorkflowDocument);

  return buildWorkflowArtifactProjection({
    artifacts: params.artifacts,
    document: {
      ...document,
      nodes: document.nodes.map((node) =>
        (node.kind === "imageGenerator" ||
          node.kind === "videoGenerator" ||
          node.kind === "llmGenerator") &&
        node.reviewEnabled
          ? { ...node, outputs: [] }
          : node,
      ),
    },
  });
}

function buildWorkflowArtifactProjection(params: {
  artifacts: WorkflowOutputArtifacts;
  document: WorkflowDocument | WorkflowGraphDocument;
}) {
  const document =
    hydrateWorkflowGraphDocument(toWorkflowGraphDocument(params.document)) ??
    (params.document as WorkflowDocument);
  const outputByNodeId = groupByNodeId(
    getVisibleLatestOutputs(params.artifacts),
  );
  const latestOutputByOutput = getLatestOutputs(
    getMaterializedWorkflowOutputs(params.artifacts),
  );
  const reviewByNodeId = groupByNodeId(
    getLatestOutputReviewArtifacts(params.artifacts),
  );

  return {
    ...document,
    nodes: document.nodes.map((node) => {
      const artifactOutputs = outputByNodeId.get(node.id) ?? [];
      const reviewOutputs = reviewByNodeId.get(node.id) ?? [];

      if (node.kind === "imageGenerator" || node.kind === "videoGenerator") {
        const valueType = node.kind === "imageGenerator" ? "image" : "video";
        const outputs = artifactOutputs.reduce(
          (outputs, output) =>
            output.value.type === valueType
              ? replaceMediaOutputOutput(
                  outputs,
                  output.outputIndex,
                  output.value.items[0] ?? [],
                )
              : outputs,
          node.outputs,
        );
        const review = reviewOutputs.length
          ? ({
              outputs: reviewOutputs
                .map((reviewOutput) => {
                  const output =
                    artifactOutputs.find(
                      (candidate) =>
                        candidate.outputIndex === reviewOutput.outputIndex &&
                        candidate.attempt === reviewOutput.attempt,
                    ) ??
                    latestOutputByOutput.get(
                      getWorkflowOutputKey(reviewOutput),
                    );
                  return {
                    assets:
                      output?.value.type === "image" ||
                      output?.value.type === "video"
                        ? (output.value.items[0] ?? [])
                        : [],
                    attempt: reviewOutput.attempt,
                    executionId: reviewOutput.executionId,
                    outputIndex: reviewOutput.outputIndex,
                    status: reviewOutput.status,
                    text: null,
                  };
                })
                .sort((left, right) => left.outputIndex - right.outputIndex),
              sourceNodeId: node.id,
              updatedAt: null,
              valueType,
            } satisfies WorkflowReviewState)
          : node.review;

        return node.kind === "imageGenerator"
          ? {
              ...ImageGeneratorService.setExecutionResult(node, {
                lastPrompt: node.lastPrompt,
                outputs,
              }),
              review,
            }
          : {
              ...VideoGeneratorService.setExecutionResult(node, {
                lastPrompt: node.lastPrompt,
                outputs,
              }),
              review,
            };
      }

      if (node.kind === "llmGenerator") {
        const outputs = artifactOutputs.reduce(
          (outputs, output) =>
            output.value.type === "text"
              ? replaceTextOutputOutput(
                  outputs,
                  output.outputIndex,
                  output.value.items[0] ?? "",
                )
              : outputs,
          node.outputs,
        );
        const review = reviewOutputs.length
          ? ({
              outputs: reviewOutputs
                .map((reviewOutput) => {
                  const output =
                    artifactOutputs.find(
                      (candidate) =>
                        candidate.outputIndex === reviewOutput.outputIndex &&
                        candidate.attempt === reviewOutput.attempt,
                    ) ??
                    latestOutputByOutput.get(
                      getWorkflowOutputKey(reviewOutput),
                    );
                  return {
                    assets: [],
                    attempt: reviewOutput.attempt,
                    executionId: reviewOutput.executionId,
                    outputIndex: reviewOutput.outputIndex,
                    status: reviewOutput.status,
                    text:
                      output?.value.type === "text"
                        ? (output.value.items[0] ?? null)
                        : null,
                  };
                })
                .sort((left, right) => left.outputIndex - right.outputIndex),
              sourceNodeId: node.id,
              updatedAt: null,
              valueType: "text",
            } satisfies WorkflowReviewState)
          : node.review;

        return {
          ...LlmGeneratorService.setExecutionResult(node, {
            lastPrompt: node.lastPrompt,
            lastSystemPrompt: node.lastSystemPrompt,
            outputs,
          }),
          review,
        };
      }

      return node;
    }),
  } satisfies WorkflowDocument;
}
