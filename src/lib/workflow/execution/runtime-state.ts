import type { WorkflowDocument } from "~/lib/workflow/document";
import type {
  WorkflowCreditsSummary,
  WorkflowExecutionNodeRuntimeState,
  WorkflowExecutionRequestContext,
  WorkflowExecutionRuntimeState,
  WorkflowExecutionStatus,
  WorkflowExecutionStatusResponse,
} from "~/lib/workflow/execution/types";
import type { WorkflowRuntimeState } from "~/lib/workflow/studio-state";

function createNodeRuntimeState(): WorkflowExecutionNodeRuntimeState {
  return {
    status: "idle",
    error: null,
  };
}

export function createWorkflowExecutionRuntimeState(
  document: WorkflowDocument,
  activity: string,
): WorkflowExecutionRuntimeState {
  return {
    activity,
    error: null,
    finishedAt: null,
    startedAt: null,
    nodeStateById: Object.fromEntries(
      document.nodes.map((node) => [node.id, createNodeRuntimeState()]),
    ),
  };
}

export function syncWorkflowExecutionRuntimeState(
  document: WorkflowDocument,
  runtime: WorkflowExecutionRuntimeState,
): WorkflowExecutionRuntimeState {
  return {
    ...runtime,
    nodeStateById: Object.fromEntries(
      document.nodes.map((node) => [
        node.id,
        runtime.nodeStateById[node.id] ?? createNodeRuntimeState(),
      ]),
    ),
  };
}

export function toWorkflowStudioRuntimeState(
  runtime: WorkflowExecutionRuntimeState,
): WorkflowRuntimeState {
  return {
    activity: runtime.activity,
    nodeStateById: runtime.nodeStateById,
  };
}

export function buildWorkflowExecutionStatusResponse(params: {
  executionId: string;
  targetNodeIds: string[];
  accruedCostCredits?: number | null;
  projectDocumentRevision?: number | null;
  finalCostCredits?: number | null;
  document: WorkflowDocument;
  runtime: WorkflowExecutionRuntimeState;
  requestContext?: WorkflowExecutionRequestContext | null;
  status: WorkflowExecutionStatus;
  credits?: WorkflowCreditsSummary | null;
}): WorkflowExecutionStatusResponse {
  return {
    accruedCostCredits: params.accruedCostCredits ?? 0,
    executionId: params.executionId,
    targetNodeIds: params.targetNodeIds,
    projectDocumentRevision: params.projectDocumentRevision ?? null,
    finalCostCredits: params.finalCostCredits ?? null,
    document: params.document,
    runtime: params.runtime,
    requestContext: params.requestContext ?? null,
    activity: params.runtime.activity,
    credits: params.credits ?? null,
    status: params.status,
  };
}
