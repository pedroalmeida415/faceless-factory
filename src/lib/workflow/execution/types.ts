import type { Effect } from "effect";

import type { WorkflowDocument } from "~/lib/workflow/document";
import type {
  WorkflowConfigError,
  WorkflowExecutionError,
  WorkflowGenerationError,
  WorkflowStorageError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import type {
  GenerateImageRequest,
  GenerateImageResponse,
  GenerateVideoRequest,
  GenerateVideoResponse,
  WorkflowNodeStatus,
} from "~/lib/workflow/types";

export type WorkflowExecutionTarget =
  | { type: "selected-or-all" }
  | { type: "node"; nodeId: string };

export type WorkflowExecutionSelection = {
  nodeIds: string[];
};

export type StartWorkflowExecutionRequest = {
  document: WorkflowDocument;
  target: WorkflowExecutionTarget;
  selection?: WorkflowExecutionSelection | null;
  clientRunId?: string | null;
  documentVersion?: number | null;
  idempotencyKey?: string | null;
};

export type WorkflowRunStatus = "queued" | "running" | "success" | "error";

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
  runId: string;
  document: WorkflowDocument;
  runtime: WorkflowExecutionRuntimeState;
  activity: string;
  credits: WorkflowCreditsSummary | null;
  status: WorkflowRunStatus;
};

export type WorkflowExecutionPortError =
  | WorkflowConfigError
  | WorkflowExecutionError
  | WorkflowGenerationError
  | WorkflowStorageError
  | WorkflowValidationError;

export type WorkflowExecutionPorts = {
  readonly generateImage: (
    request: GenerateImageRequest,
  ) => Effect.Effect<GenerateImageResponse, WorkflowExecutionPortError>;
  readonly generateVideo: (
    request: GenerateVideoRequest,
  ) => Effect.Effect<GenerateVideoResponse, WorkflowExecutionPortError>;
  readonly onStateChange?: (
    state: WorkflowExecutionStatusResponse,
  ) => Effect.Effect<void, never>;
};
