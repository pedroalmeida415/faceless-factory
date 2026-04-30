import type { WorkflowDocumentNode } from "~/lib/workflow/document";
import {
  getWorkflowOutputKey,
  type WorkflowOutputIdentity,
} from "~/lib/workflow/execution/output-dependencies";
import type {
  NodeOutputArtifact,
  WorkflowOutputResultArtifact,
} from "~/lib/workflow/execution/types";
import type { RuntimeValue } from "~/lib/workflow/runtime-values";

export type ReusableWorkflowOutputCandidate = WorkflowOutputResultArtifact & {
  updatedAt: string;
};

export type WorkflowOutputReuseRole = "dependency" | "requested-target";

export type WorkflowOutputReusePolicy =
  | { type: "dependencies-only" }
  | { type: "recover-requested-targets" };

export type ExpectedReusableWorkflowOutput = WorkflowOutputIdentity & {
  role: WorkflowOutputReuseRole;
  reviewEnabled: boolean;
  valueType: RuntimeValue["type"];
};

export function getGeneratorOutputValueType(
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

export function hasMaterializedWorkflowOutputValue(value: RuntimeValue) {
  const output = value.items[0];
  return value.type === "text"
    ? typeof output === "string" && output.trim().length > 0
    : Array.isArray(output) && output.length > 0;
}

function compareCandidateRecency(
  left: ReusableWorkflowOutputCandidate,
  right: ReusableWorkflowOutputCandidate,
) {
  return (
    new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime() ||
    left.attempt - right.attempt ||
    left.executionId.localeCompare(right.executionId)
  );
}

function isReusableOutput(
  candidate: ReusableWorkflowOutputCandidate,
  expected: ExpectedReusableWorkflowOutput,
  canReuseRequestedTargets: boolean,
): candidate is ReusableWorkflowOutputCandidate & NodeOutputArtifact {
  const canReuseForRole =
    expected.role === "dependency" || canReuseRequestedTargets;

  return (
    candidate.status === "success" &&
    candidate.nodeId === expected.nodeId &&
    candidate.outputIndex === expected.outputIndex &&
    candidate.value.type === expected.valueType &&
    hasMaterializedWorkflowOutputValue(candidate.value) &&
    canReuseForRole &&
    (!expected.reviewEnabled || candidate.reviewStatus === "approved")
  );
}

export function selectReusableWorkflowOutputs(params: {
  candidates: readonly ReusableWorkflowOutputCandidate[];
  expectedOutputs: readonly ExpectedReusableWorkflowOutput[];
  reusePolicy: WorkflowOutputReusePolicy;
}) {
  const expectedByOutput = new Map(
    params.expectedOutputs.map((output) => [
      getWorkflowOutputKey(output),
      output,
    ]),
  );
  const canReuseRequestedTargets =
    params.reusePolicy.type === "recover-requested-targets" &&
    params.candidates.some((candidate) => {
      const expected = expectedByOutput.get(getWorkflowOutputKey(candidate));
      return (
        expected?.role === "requested-target" && candidate.status === "error"
      );
    });
  const latestByOutput = new Map<string, ReusableWorkflowOutputCandidate>();

  for (const candidate of params.candidates) {
    const key = getWorkflowOutputKey(candidate);
    if (!expectedByOutput.has(key)) {
      continue;
    }

    const latest = latestByOutput.get(key);
    if (!latest || compareCandidateRecency(latest, candidate) < 0) {
      latestByOutput.set(key, candidate);
    }
  }

  return Array.from(latestByOutput.entries()).flatMap(([key, candidate]) => {
    const expected = expectedByOutput.get(key);
    return expected &&
      isReusableOutput(candidate, expected, canReuseRequestedTargets)
      ? [candidate]
      : [];
  });
}
