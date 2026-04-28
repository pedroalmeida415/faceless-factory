import type { WorkflowDocumentNode } from "~/lib/workflow/document";
import {
  getWorkflowLaneKey,
  type WorkflowLaneIdentity,
} from "~/lib/workflow/execution/lane-dependencies";
import type {
  NodeLaneOutputArtifact,
  WorkflowLaneResultArtifact,
} from "~/lib/workflow/execution/types";
import type { RuntimeValue } from "~/lib/workflow/lanes";

export type ReusableWorkflowLaneCandidate = WorkflowLaneResultArtifact & {
  updatedAt: string;
};

export type ExpectedReusableWorkflowLane = WorkflowLaneIdentity & {
  isRequestedTarget: boolean;
  reviewEnabled: boolean;
  valueType: RuntimeValue["type"];
};

export function getGeneratorLaneValueType(
  node: WorkflowDocumentNode | undefined,
): RuntimeValue["type"] | null {
  switch (node?.kind) {
    case "imageGenerator":
      return "image";
    case "videoGenerator":
      return "video";
    case "llmGenerator":
      return "text";
    default:
      return null;
  }
}

export function hasMaterializedWorkflowLaneValue(value: RuntimeValue) {
  const lane = value.lanes[0];
  return value.type === "text"
    ? typeof lane === "string" && lane.trim().length > 0
    : Array.isArray(lane) && lane.length > 0;
}

function compareCandidateRecency(
  left: ReusableWorkflowLaneCandidate,
  right: ReusableWorkflowLaneCandidate,
) {
  return (
    new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime() ||
    left.attempt - right.attempt ||
    left.runId.localeCompare(right.runId)
  );
}

function isReusableLaneOutput(
  candidate: ReusableWorkflowLaneCandidate,
  expected: ExpectedReusableWorkflowLane,
): candidate is ReusableWorkflowLaneCandidate & NodeLaneOutputArtifact {
  return (
    candidate.status === "success" &&
    candidate.nodeId === expected.nodeId &&
    candidate.laneIndex === expected.laneIndex &&
    candidate.value.type === expected.valueType &&
    hasMaterializedWorkflowLaneValue(candidate.value) &&
    (!expected.reviewEnabled ||
      (!expected.isRequestedTarget && candidate.reviewStatus === "approved"))
  );
}

export function selectReusableWorkflowLaneOutputs(params: {
  candidates: readonly ReusableWorkflowLaneCandidate[];
  expectedLanes: readonly ExpectedReusableWorkflowLane[];
}) {
  const expectedByLane = new Map(
    params.expectedLanes.map((lane) => [getWorkflowLaneKey(lane), lane]),
  );
  const latestByLane = new Map<string, ReusableWorkflowLaneCandidate>();

  for (const candidate of params.candidates) {
    const key = getWorkflowLaneKey(candidate);
    if (!expectedByLane.has(key)) {
      continue;
    }

    const latest = latestByLane.get(key);
    if (!latest || compareCandidateRecency(latest, candidate) < 0) {
      latestByLane.set(key, candidate);
    }
  }

  return Array.from(latestByLane.entries()).flatMap(([key, candidate]) => {
    const expected = expectedByLane.get(key);
    return expected && isReusableLaneOutput(candidate, expected)
      ? [candidate]
      : [];
  });
}
