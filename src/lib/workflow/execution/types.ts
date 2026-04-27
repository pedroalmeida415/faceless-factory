import type { Effect } from "effect";

import type { WorkflowDocument } from "~/lib/workflow/document";
import type {
  WorkflowAuthorizationError,
  WorkflowConfigError,
  WorkflowCreditsError,
  WorkflowExecutionError,
  WorkflowGenerationError,
  WorkflowInfrastructureError,
  WorkflowStorageError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
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
};

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

export type WorkflowArtifactLineage = {
  runId: string;
  sourceNodeId: string;
  sourceLaneIndex: number;
  sourceAttempt: number;
  dependentNodeId: string;
  dependentLaneIndex: number;
  dependentAttempt: number;
};

export type LaneExecutionResult = {
  runId: string;
  laneIndex: number | null;
  outputs: NodeLaneOutputArtifact[];
  reviewLanes: ReviewLaneArtifact[];
  lineage: WorkflowArtifactLineage[];
  status: WorkflowRunArtifactStatus;
  costCredits: number;
};

export type WorkflowRunArtifacts = {
  outputs: NodeLaneOutputArtifact[];
  reviewLanes: ReviewLaneArtifact[];
  lineage: WorkflowArtifactLineage[];
};

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
