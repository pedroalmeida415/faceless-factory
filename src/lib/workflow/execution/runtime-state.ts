import type { WorkflowDocument } from "~/lib/workflow/document";
import type {
  WorkflowExecutionNodeRuntimeState,
  WorkflowExecutionRuntimeState,
  WorkflowExecutionStatusResponse,
  WorkflowRunStatus,
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
  runId: string;
  document: WorkflowDocument;
  runtime: WorkflowExecutionRuntimeState;
  status: WorkflowRunStatus;
}): WorkflowExecutionStatusResponse {
  return {
    runId: params.runId,
    document: params.document,
    runtime: params.runtime,
    activity: params.runtime.activity,
    credits: null,
    status: params.status,
  };
}
