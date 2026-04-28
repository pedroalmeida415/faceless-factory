import type { Effect } from "effect";
import type { WorkflowDocument } from "~/lib/workflow/document";
import type {
  WorkflowAuthorizationError,
  WorkflowConfigError,
  WorkflowCreditsError,
  WorkflowGenerationError,
  WorkflowInfrastructureError,
  WorkflowStorageError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import { WorkflowExecutionError } from "~/lib/workflow/errors";
import type { RuntimeValue } from "~/lib/workflow/lanes";
import type {
  GenerateImageRequest,
  GenerateImageResponse,
  GenerateLlmRequest,
  GenerateLlmResponse,
  GenerateVideoRequest,
  GenerateVideoResponse,
  WorkflowNodeStatus,
  WorkflowReviewLaneStatus,
} from "~/lib/workflow/types";

export type WorkflowExecutionTarget =
  | { type: "selected-or-all" }
  | { type: "node"; nodeId: string };

export type WorkflowExecutionSelection = {
  nodeIds: string[];
};

export type StartWorkflowExecutionRequest = {
  accruedCostCredits?: number | null;
  document: WorkflowDocument;
  projectId?: string | null;
  target: WorkflowExecutionTarget;
  selection?: WorkflowExecutionSelection | null;
  clientRunId?: string | null;
  documentRevision?: number | null;
  idempotencyKey?: string | null;
  executionLaneFilter?: {
    laneCount: number;
    laneIndex: number;
  } | null;
  reviewLaneFilter?: {
    laneIndex: number;
    reviewNodeId: string;
  } | null;
};

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting_for_review"
  | "success"
  | "error";

export type WorkflowRunArtifactStatus = Extract<
  WorkflowRunStatus,
  "running" | "waiting_for_review" | "success" | "error"
>;

export type NodeLaneOutputArtifact = {
  runId: string;
  projectId: string;
  ownerUserId: string;
  nodeId: string;
  laneIndex: number;
  attempt: number;
  documentRevision: number | null;
  value: RuntimeValue;
  inputHash: string;
  idempotencyKey: string;
  promptSnapshot: string | null;
  model: string | null;
  reviewStatus: WorkflowReviewLaneStatus | null;
};

export type WorkflowLaneErrorArtifact = {
  runId: string;
  projectId: string;
  ownerUserId: string;
  nodeId: string;
  laneIndex: number;
  attempt: number;
  error: string;
  failedAt: string;
};

export type WorkflowLaneResultArtifact =
  | ({ status: "success" } & NodeLaneOutputArtifact)
  | ({ status: "error" } & WorkflowLaneErrorArtifact);

export type ReviewLaneArtifact = {
  runId: string;
  projectId: string;
  ownerUserId: string;
  nodeId: string;
  laneIndex: number;
  attempt: number;
  valueType: RuntimeValue["type"];
  status: WorkflowReviewLaneStatus;
};

export type LaneExecutionResult = {
  runId: string;
  laneIndex: number | null;
  outputs: NodeLaneOutputArtifact[];
  status: WorkflowRunArtifactStatus;
  costCredits: number;
};

export type WorkflowRunArtifacts = {
  laneResults: WorkflowLaneResultArtifact[];
};

function workflowLaneResultKey(result: WorkflowLaneResultArtifact) {
  return `${result.runId}:${result.nodeId}:${result.laneIndex}`;
}

export function getLatestWorkflowLaneResults(artifacts: WorkflowRunArtifacts) {
  const latest = new Map<string, WorkflowLaneResultArtifact>();
  for (const result of artifacts.laneResults) {
    const key = workflowLaneResultKey(result);
    const existing = latest.get(key);
    if (!existing || existing.attempt < result.attempt) {
      latest.set(key, result);
    }
  }
  return Array.from(latest.values());
}

export function getSuccessfulWorkflowLaneOutputs(
  artifacts: WorkflowRunArtifacts,
) {
  return getLatestWorkflowLaneResults(artifacts).flatMap((result) =>
    result.status === "success" ? [result] : [],
  );
}

export function getLatestReviewLaneArtifacts(artifacts: WorkflowRunArtifacts) {
  const latest = new Map<string, ReviewLaneArtifact>();
  for (const output of getSuccessfulWorkflowLaneOutputs(artifacts)) {
    if (!output.reviewStatus) {
      continue;
    }
    const key = `${output.runId}:${output.nodeId}:${output.laneIndex}`;
    const existing = latest.get(key);
    if (!existing || existing.attempt < output.attempt) {
      latest.set(key, {
        attempt: output.attempt,
        laneIndex: output.laneIndex,
        nodeId: output.nodeId,
        ownerUserId: output.ownerUserId,
        projectId: output.projectId,
        runId: output.runId,
        status: output.reviewStatus,
        valueType: output.value.type,
      });
    }
  }
  return Array.from(latest.values());
}

export function getErroredWorkflowLaneResults(artifacts: WorkflowRunArtifacts) {
  return getLatestWorkflowLaneResults(artifacts).flatMap((result) =>
    result.status === "error" ? [result] : [],
  );
}

export type NodeLaneOutputQuery = {
  runId: string;
  ownerUserId: string;
  nodeId: string;
  laneIndex: number;
  attempt: number;
  inputHash: string;
};

export type RegenerationAttemptRequest = {
  runId: string;
  ownerUserId: string;
  nodeId: string;
  laneIndex: number;
};

export function isWorkflowRunActiveStatus(status: WorkflowRunStatus) {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_review"
  );
}

export function isWorkflowRunLockingStatus(status: WorkflowRunStatus) {
  return status === "queued" || status === "running";
}

export type WorkflowExecutionRequestContext = Omit<
  StartWorkflowExecutionRequest,
  "document" | "executionLaneFilter" | "reviewLaneFilter"
>;

export type WorkflowExecutionNodeRuntimeState = {
  status: WorkflowNodeStatus;
  error: string | null;
};

export type WorkflowExecutionRuntimeState = {
  nodeStateById: Record<string, WorkflowExecutionNodeRuntimeState>;
  activity: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

export type WorkflowCreditsSummary = {
  available: number;
  reserved: number;
  used: number;
  totalCost: number;
};

export type WorkflowExecutionStatusResponse = {
  accruedCostCredits: number;
  runId: string;
  targetNodeIds: string[];
  projectDocumentRevision: number | null;
  finalCostCredits: number | null;
  document: WorkflowDocument;
  runtime: WorkflowExecutionRuntimeState;
  requestContext: WorkflowExecutionRequestContext | null;
  activity: string;
  credits: WorkflowCreditsSummary | null;
  status: WorkflowRunStatus;
};

export type WorkflowExecutionPortError =
  | WorkflowAuthorizationError
  | WorkflowCreditsError
  | WorkflowConfigError
  | WorkflowExecutionError
  | WorkflowGenerationError
  | WorkflowInfrastructureError
  | WorkflowStorageError
  | WorkflowValidationError;

export class WorkflowReviewPause {
  readonly _tag = "WorkflowReviewPause";
}

export class WorkflowLaneDependencyMissing extends WorkflowExecutionError {
  constructor(
    readonly params: {
      laneIndex: number;
      nodeId: string;
      nodeLabel: string;
    },
  ) {
    super({
      message: `Invariant violation: ${params.nodeLabel} lane ${params.laneIndex + 1} was scheduled before upstream lane ${params.nodeId}:${params.laneIndex} was visible.`,
    });
  }
}

export type WorkflowExecutionPorts = {
  readonly generateImage: (
    request: GenerateImageRequest,
  ) => Effect.Effect<GenerateImageResponse, WorkflowExecutionPortError>;
  readonly generateVideo: (
    request: GenerateVideoRequest,
  ) => Effect.Effect<GenerateVideoResponse, WorkflowExecutionPortError>;
  readonly generateLlm: (
    request: GenerateLlmRequest,
  ) => Effect.Effect<GenerateLlmResponse, WorkflowExecutionPortError>;
  readonly getNodeLaneOutput: (
    query: Omit<NodeLaneOutputQuery, "ownerUserId">,
  ) => Effect.Effect<NodeLaneOutputArtifact | null, WorkflowExecutionPortError>;
  readonly getNodeLaneValue: (query: {
    runId: string;
    nodeId: string;
    laneIndex: number;
  }) => Effect.Effect<RuntimeValue | null, WorkflowExecutionPortError>;
  readonly onCompleted?: (params: {
    document: WorkflowDocument;
    finalCostCredits: number;
    request: StartWorkflowExecutionRequest;
    runId: string;
    targetNodeIds: string[];
  }) => Effect.Effect<number | null, WorkflowExecutionPortError>;
  readonly onStateChange?: (
    state: WorkflowExecutionStatusResponse,
  ) => Effect.Effect<void, never>;
};
