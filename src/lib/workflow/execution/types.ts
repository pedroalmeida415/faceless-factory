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
import type { RuntimeValue } from "~/lib/workflow/runtime-values";
import type {
  GenerateImageRequest,
  GenerateImageResponse,
  GenerateLlmRequest,
  GenerateLlmResponse,
  GenerateVideoRequest,
  GenerateVideoResponse,
  WorkflowNodeStatus,
  WorkflowOutputReviewStatus,
} from "~/lib/workflow/types";

export type WorkflowExecutionTarget = { type: "node"; nodeId: string };

export type WorkflowExecutionSelection = {
  nodeIds: string[];
};

export type StartWorkflowExecutionRequest = {
  accruedCostCredits?: number | null;
  document: WorkflowDocument;
  projectId?: string | null;
  target: WorkflowExecutionTarget;
  selection?: WorkflowExecutionSelection | null;
  clientExecutionId?: string | null;
  documentRevision?: number | null;
  idempotencyKey?: string | null;
  executionOutputFilter?: {
    outputCount: number;
    outputIndex: number;
  } | null;
  reviewOutputFilter?: {
    outputIndex: number;
    reviewNodeId: string;
  } | null;
};

export type TaskRunExecutionDocumentSnapshot = {
  type: "workflow-task-run-execution-document-snapshot";
  version: 1;
  projectId: string;
  executionId: string;
  jobId: string;
  taskRunId: string;
  targetNodeId: string;
  outputIndex: number;
  outputCount: number;
  documentRevision: number | null;
  document: WorkflowDocument;
  resolvedUpstreamOutputs: NodeOutputArtifact[];
  requestContext: WorkflowExecutionRequestContext;
};

export type WorkflowExecutionStatus =
  | "queued"
  | "running"
  | "waiting_for_review"
  | "success"
  | "error";

export type WorkflowOutputArtifactStatus = Extract<
  WorkflowExecutionStatus,
  "running" | "waiting_for_review" | "success" | "error"
>;

export type NodeOutputArtifact = {
  executionId: string;
  projectId: string;
  ownerUserId: string;
  nodeId: string;
  outputIndex: number;
  attempt: number;
  documentRevision: number | null;
  value: RuntimeValue;
  inputHash: string;
  idempotencyKey: string;
  promptSnapshot: string | null;
  model: string | null;
  reviewStatus: WorkflowOutputReviewStatus | null;
};

export type WorkflowOutputErrorArtifact = {
  executionId: string;
  projectId: string;
  ownerUserId: string;
  nodeId: string;
  outputIndex: number;
  attempt: number;
  error: string;
  failedAt: string;
};

export type WorkflowOutputResultArtifact =
  | ({ status: "success" | "waiting_for_review" } & NodeOutputArtifact)
  | ({ status: "error" } & WorkflowOutputErrorArtifact);

export type OutputReviewArtifact = {
  executionId: string;
  projectId: string;
  ownerUserId: string;
  nodeId: string;
  outputIndex: number;
  attempt: number;
  valueType: RuntimeValue["type"];
  status: WorkflowOutputReviewStatus;
};

export type OutputExecutionResult = {
  executionId: string;
  outputIndex: number | null;
  outputs: NodeOutputArtifact[];
  status: WorkflowOutputArtifactStatus;
  costCredits: number;
  costCreditsByOutputKey?: ReadonlyMap<string, number>;
};

export type WorkflowOutputArtifacts = {
  outputResults: WorkflowOutputResultArtifact[];
};

export function getWorkflowOutputKey(output: {
  nodeId: string;
  outputIndex: number;
}) {
  return `${output.nodeId}:${output.outputIndex}`;
}

export type WorkflowCurrentOutputSlot = {
  currentAttempt: WorkflowOutputResultArtifact;
  committedOutput: NodeOutputArtifact | null;
};

export type WorkflowCurrentOutputProjection = ReadonlyMap<
  string,
  WorkflowCurrentOutputSlot
>;

function workflowOutputResultKey(result: WorkflowOutputResultArtifact) {
  return `${result.projectId}:${result.nodeId}:${result.outputIndex}`;
}

export function getLatestWorkflowOutputResults(
  artifacts: WorkflowOutputArtifacts,
) {
  const latest = new Map<string, WorkflowOutputResultArtifact>();
  for (const result of artifacts.outputResults) {
    const key = workflowOutputResultKey(result);
    const existing = latest.get(key);
    if (!existing || existing.attempt < result.attempt) {
      latest.set(key, result);
    }
  }
  return Array.from(latest.values());
}

export function buildCurrentWorkflowOutputProjection(
  artifacts: WorkflowOutputArtifacts,
): WorkflowCurrentOutputProjection {
  return new Map(
    getLatestWorkflowOutputResults(artifacts).map((result) => [
      workflowOutputResultKey(result),
      {
        currentAttempt: result,
        committedOutput: result.status === "success" ? result : null,
      },
    ]),
  );
}

export function getSuccessfulWorkflowOutputs(
  artifacts: WorkflowOutputArtifacts,
) {
  return getLatestWorkflowOutputResults(artifacts).flatMap((result) =>
    result.status === "success" ? [result] : [],
  );
}

export function getMaterializedWorkflowOutputs(
  artifacts: WorkflowOutputArtifacts,
) {
  return getLatestWorkflowOutputResults(artifacts).flatMap((result) =>
    result.status === "success" || result.status === "waiting_for_review"
      ? [result]
      : [],
  );
}

export function getLatestOutputReviewArtifacts(
  artifacts: WorkflowOutputArtifacts,
) {
  const latest = new Map<string, OutputReviewArtifact>();
  for (const output of getMaterializedWorkflowOutputs(artifacts)) {
    if (!output.reviewStatus) {
      continue;
    }
    const key = `${output.projectId}:${output.nodeId}:${output.outputIndex}`;
    const existing = latest.get(key);
    if (!existing || existing.attempt < output.attempt) {
      latest.set(key, {
        attempt: output.attempt,
        outputIndex: output.outputIndex,
        nodeId: output.nodeId,
        ownerUserId: output.ownerUserId,
        projectId: output.projectId,
        executionId: output.executionId,
        status: output.reviewStatus,
        valueType: output.value.type,
      });
    }
  }
  return Array.from(latest.values());
}

export function getErroredWorkflowOutputResults(
  artifacts: WorkflowOutputArtifacts,
) {
  return getLatestWorkflowOutputResults(artifacts).flatMap((result) =>
    result.status === "error" ? [result] : [],
  );
}

export type NodeOutputQuery = {
  executionId: string;
  projectId?: string | null;
  ownerUserId: string;
  nodeId: string;
  outputIndex: number;
  attempt: number;
  inputHash: string;
};

export type RegenerationAttemptRequest = {
  executionId: string;
  projectId?: string | null;
  ownerUserId: string;
  nodeId: string;
  outputIndex: number;
};

export function isWorkflowExecutionActiveStatus(
  status: WorkflowExecutionStatus,
) {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_review"
  );
}

export function isWorkflowExecutionLockingStatus(
  status: WorkflowExecutionStatus,
) {
  return status === "queued" || status === "running";
}

export type WorkflowExecutionRequestContext = Omit<
  StartWorkflowExecutionRequest,
  "document" | "executionOutputFilter" | "reviewOutputFilter"
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
  executionId: string;
  targetNodeIds: string[];
  projectDocumentRevision: number | null;
  finalCostCredits: number | null;
  document: WorkflowDocument;
  runtime: WorkflowExecutionRuntimeState;
  requestContext: WorkflowExecutionRequestContext | null;
  activity: string;
  credits: WorkflowCreditsSummary | null;
  status: WorkflowExecutionStatus;
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

export class WorkflowOutputDependencyMissing extends WorkflowExecutionError {
  constructor(
    readonly params: {
      outputIndex: number;
      nodeId: string;
      nodeLabel: string;
    },
  ) {
    super({
      message: `Invariant violation: ${params.nodeLabel} output ${params.outputIndex + 1} was scheduled before upstream output ${params.nodeId}:${params.outputIndex} was visible.`,
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
  readonly getNodeOutput: (
    query: Omit<NodeOutputQuery, "ownerUserId">,
  ) => Effect.Effect<NodeOutputArtifact | null, WorkflowExecutionPortError>;
  readonly getNodeOutputValue: (query: {
    executionId: string;
    nodeId: string;
    outputIndex: number;
  }) => Effect.Effect<RuntimeValue | null, WorkflowExecutionPortError>;
  readonly onOutputCost?: (params: {
    amount: number;
    attempt: number;
    idempotencyKey: string;
    inputHash: string;
    nodeId: string;
    outputIndex: number;
  }) => Effect.Effect<number, WorkflowExecutionPortError>;
  readonly onCompleted?: (params: {
    document: WorkflowDocument;
    finalCostCredits: number;
    request: StartWorkflowExecutionRequest;
    executionId: string;
    targetNodeIds: string[];
  }) => Effect.Effect<number | null, WorkflowExecutionPortError>;
  readonly onStateChange?: (
    state: WorkflowExecutionStatusResponse,
  ) => Effect.Effect<void, never>;
};
