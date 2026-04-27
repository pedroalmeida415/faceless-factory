import {
  hydrateWorkflowGraphDocument,
  toWorkflowGraphDocument,
  type WorkflowDocument,
  type WorkflowGraphDocument,
} from "~/lib/workflow/document";
import {
  replaceMediaOutputLane,
  replaceTextOutputLane,
} from "~/lib/workflow/execution/output-lanes";
import type {
  NodeLaneOutputArtifact,
  ReviewLaneArtifact,
  WorkflowArtifactLineage,
  WorkflowRunArtifacts,
} from "~/lib/workflow/execution/types";
import {
  ImageGeneratorService,
  LlmGeneratorService,
  VideoGeneratorService,
} from "~/lib/workflow/services/node-services";
import type { WorkflowReviewState } from "~/lib/workflow/types";

function latestLaneOutputKey(output: NodeLaneOutputArtifact) {
  return `${output.runId}:${output.nodeId}:${output.laneIndex}`;
}

function outputAttemptKey(output: NodeLaneOutputArtifact) {
  return `${output.runId}:${output.nodeId}:${output.laneIndex}:${output.attempt}`;
}

function reviewLaneKey(lane: ReviewLaneArtifact) {
  return `${lane.runId}:${lane.nodeId}:${lane.laneIndex}`;
}

function getLatestOutputs(outputs: readonly NodeLaneOutputArtifact[]) {
  const latest = new Map<string, NodeLaneOutputArtifact>();
  for (const output of outputs) {
    const key = latestLaneOutputKey(output);
    const existing = latest.get(key);
    if (!existing || existing.attempt < output.attempt) {
      latest.set(key, output);
    }
  }
  return latest;
}

function getLatestReviewLanes(reviewLanes: readonly ReviewLaneArtifact[]) {
  const latest = new Map<string, ReviewLaneArtifact>();
  for (const lane of reviewLanes) {
    const key = reviewLaneKey(lane);
    const existing = latest.get(key);
    if (!existing || existing.attempt < lane.attempt) {
      latest.set(key, lane);
    }
  }
  return latest;
}

function lineageDependentKey(lineage: WorkflowArtifactLineage) {
  return `${lineage.runId}:${lineage.dependentNodeId}:${lineage.dependentLaneIndex}:${lineage.dependentAttempt}`;
}

function groupLineageByDependent(lineage: readonly WorkflowArtifactLineage[]) {
  const grouped = new Map<string, WorkflowArtifactLineage[]>();
  for (const entry of lineage) {
    const key = lineageDependentKey(entry);
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  return grouped;
}

function getVisibleLatestOutputs(artifacts: WorkflowRunArtifacts) {
  const latestOutputs = getLatestOutputs(artifacts.outputs);
  const outputByAttempt = new Map(
    artifacts.outputs.map((output) => [outputAttemptKey(output), output]),
  );
  const latestReviewByLane = getLatestReviewLanes(artifacts.reviewLanes);
  const lineageByDependent = groupLineageByDependent(artifacts.lineage);
  const visibleByAttempt = new Map<string, boolean>();

  const isVisible = (
    output: NodeLaneOutputArtifact,
    visiting = new Set<string>(),
  ): boolean => {
    const key = outputAttemptKey(output);
    const cached = visibleByAttempt.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(key)) {
      return false;
    }

    visiting.add(key);
    const isOutputVisible: boolean = (lineageByDependent.get(key) ?? []).every(
      (lineage) => {
        const sourceLatest = latestOutputs.get(
          `${lineage.runId}:${lineage.sourceNodeId}:${lineage.sourceLaneIndex}`,
        );
        if (!sourceLatest || sourceLatest.attempt !== lineage.sourceAttempt) {
          return false;
        }

        const reviewLane = latestReviewByLane.get(
          `${lineage.runId}:${lineage.sourceNodeId}:${lineage.sourceLaneIndex}`,
        );
        if (
          reviewLane &&
          (reviewLane.status !== "approved" ||
            reviewLane.attempt !== lineage.sourceAttempt)
        ) {
          return false;
        }

        const sourceOutput = outputByAttempt.get(
          `${lineage.runId}:${lineage.sourceNodeId}:${lineage.sourceLaneIndex}:${lineage.sourceAttempt}`,
        );
        return sourceOutput ? isVisible(sourceOutput, visiting) : false;
      },
    );
    visiting.delete(key);
    visibleByAttempt.set(key, isOutputVisible);
    return isOutputVisible;
  };

  return Array.from(latestOutputs.values()).filter((output) =>
    isVisible(output),
  );
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

export function buildWorkflowRunProjection(params: {
  artifacts: WorkflowRunArtifacts;
  document: WorkflowDocument | WorkflowGraphDocument;
}) {
  return buildWorkflowArtifactProjection(params);
}

export function buildWorkflowApprovedRunProjection(params: {
  artifacts: WorkflowRunArtifacts;
  document: WorkflowDocument | WorkflowGraphDocument;
}) {
  const latestReviewLanes = Array.from(
    getLatestReviewLanes(params.artifacts.reviewLanes).values(),
  );
  const approvedReviewIdentity = new Set(
    latestReviewLanes
      .filter((lane) => lane.status === "approved")
      .map((lane) => `${lane.nodeId}:${lane.laneIndex}:${lane.attempt}`),
  );
  const reviewedNodeIds = new Set(latestReviewLanes.map((lane) => lane.nodeId));

  return buildWorkflowArtifactProjection({
    artifacts: {
      lineage: params.artifacts.lineage,
      outputs: params.artifacts.outputs.filter(
        (output) =>
          !reviewedNodeIds.has(output.nodeId) ||
          approvedReviewIdentity.has(
            `${output.nodeId}:${output.laneIndex}:${output.attempt}`,
          ),
      ),
      reviewLanes: latestReviewLanes.filter(
        (lane) => lane.status === "approved",
      ),
    },
    document: params.document,
  });
}

function buildWorkflowArtifactProjection(params: {
  artifacts: WorkflowRunArtifacts;
  document: WorkflowDocument | WorkflowGraphDocument;
}) {
  const document =
    hydrateWorkflowGraphDocument(toWorkflowGraphDocument(params.document)) ??
    (params.document as WorkflowDocument);
  const outputByNodeId = groupByNodeId(
    getVisibleLatestOutputs(params.artifacts),
  );
  const reviewByNodeId = groupByNodeId(
    Array.from(getLatestReviewLanes(params.artifacts.reviewLanes).values()),
  );

  return {
    ...document,
    nodes: document.nodes.map((node) => {
      const outputs = outputByNodeId.get(node.id) ?? [];
      const reviewLanes = reviewByNodeId.get(node.id) ?? [];

      if (node.kind === "imageGenerator" || node.kind === "videoGenerator") {
        const valueType = node.kind === "imageGenerator" ? "image" : "video";
        const outputLanes = outputs.reduce(
          (lanes, output) =>
            output.value.type === valueType
              ? replaceMediaOutputLane(
                  lanes,
                  output.laneIndex,
                  output.value.lanes[0] ?? [],
                )
              : lanes,
          [] as typeof node.outputLanes,
        );
        const review = reviewLanes.length
          ? ({
              lanes: reviewLanes
                .map((lane) => {
                  const output = outputs.find(
                    (candidate) =>
                      candidate.laneIndex === lane.laneIndex &&
                      candidate.attempt === lane.attempt,
                  );
                  return {
                    assets:
                      output?.value.type === "image" ||
                      output?.value.type === "video"
                        ? (output.value.lanes[0] ?? [])
                        : [],
                    attempt: lane.attempt,
                    laneIndex: lane.laneIndex,
                    status: lane.status,
                    text: null,
                  };
                })
                .sort((left, right) => left.laneIndex - right.laneIndex),
              sourceNodeId: node.id,
              updatedAt: null,
              valueType,
            } satisfies WorkflowReviewState)
          : node.review;

        return node.kind === "imageGenerator"
          ? {
              ...ImageGeneratorService.setExecutionResult(node, {
                lastPrompt: node.lastPrompt,
                outputLanes,
              }),
              review,
            }
          : {
              ...VideoGeneratorService.setExecutionResult(node, {
                lastPrompt: node.lastPrompt,
                outputLanes,
              }),
              review,
            };
      }

      if (node.kind === "llmGenerator") {
        const outputLanes = outputs.reduce(
          (lanes, output) =>
            output.value.type === "text"
              ? replaceTextOutputLane(
                  lanes,
                  output.laneIndex,
                  output.value.lanes[0] ?? "",
                )
              : lanes,
          [] as typeof node.outputLanes,
        );
        const review = reviewLanes.length
          ? ({
              lanes: reviewLanes
                .map((lane) => {
                  const output = outputs.find(
                    (candidate) =>
                      candidate.laneIndex === lane.laneIndex &&
                      candidate.attempt === lane.attempt,
                  );
                  return {
                    assets: [],
                    attempt: lane.attempt,
                    laneIndex: lane.laneIndex,
                    status: lane.status,
                    text:
                      output?.value.type === "text"
                        ? (output.value.lanes[0] ?? null)
                        : null,
                  };
                })
                .sort((left, right) => left.laneIndex - right.laneIndex),
              sourceNodeId: node.id,
              updatedAt: null,
              valueType: "text",
            } satisfies WorkflowReviewState)
          : node.review;

        return {
          ...LlmGeneratorService.setExecutionResult(node, {
            lastPrompt: node.lastPrompt,
            lastSystemPrompt: node.lastSystemPrompt,
            outputLanes,
          }),
          review,
        };
      }

      return node;
    }),
  } satisfies WorkflowDocument;
}
