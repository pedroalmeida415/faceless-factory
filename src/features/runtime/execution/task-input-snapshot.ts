import {
  isProviderDependencyAddress,
  type ProviderDependencyAddress,
} from "~/features/runtime/domain/provider-dependency-address";
import { buildTaskIdempotencyKey } from "~/features/runtime/domain/task-state";
import type { RenderableTaskOutput } from "~/features/runtime/events/task-status-events";
import {
  type RenderedTaskProviderInput,
  renderTaskProviderInput,
  type TaskProviderInput,
} from "~/features/runtime/execution/provider-input-rendering";
import type { MaterializedProviderInputFacts } from "~/features/runtime/materialization/task-input-materialization";
import {
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDefinitionDocumentNode,
  type WorkflowDefinitionGraphDocument,
} from "~/features/workflow/document";
import type { WorkflowAsset } from "~/features/workflow/types";

export type { RenderedTaskProviderInput, TaskProviderInput };

export type ResolvedParentTaskInputSnapshot = {
  readonly taskId: string;
  readonly nodeRunId: string;
  readonly branchIndex: number;
  readonly address: ProviderDependencyAddress;
  readonly asset?: WorkflowAsset;
  readonly output?: RenderableTaskOutput;
};

export type TaskInputSnapshot = {
  readonly kind: "task-input-snapshot";
  readonly version: 1;
  readonly documentRevision: number | null;
  readonly taskId: string;
  readonly nodeRunId: string;
  readonly nodeId: string;
  readonly branchIndex: number;
  readonly idempotencyKey: string;
  readonly targetNodeConfig: WorkflowDefinitionDocumentNode;
  readonly workflowDefinition: WorkflowDefinitionGraphDocument;
  readonly resolvedParentTasks: readonly ResolvedParentTaskInputSnapshot[];
  readonly providerInput: TaskProviderInput;
};

export type ExecutableTaskInputSnapshot = TaskInputSnapshot & {
  readonly providerInput: RenderedTaskProviderInput;
};

export function buildTaskInputSnapshot(input: {
  readonly taskId: string;
  readonly nodeRunId: string;
  readonly nodeId: string;
  readonly branchIndex: number;
  readonly documentRevision?: number | null;
  readonly targetNodeConfig: WorkflowDefinitionDocumentNode;
  readonly workflowDefinition?: WorkflowDefinitionGraphDocument;
  readonly resolvedParentTasks: readonly ResolvedParentTaskInputSnapshot[];
  readonly materializedInputFacts?: MaterializedProviderInputFacts;
}): TaskInputSnapshot {
  const idempotencyKey = buildTaskIdempotencyKey({
    taskId: input.taskId,
  });
  const targetNodeConfig = structuredClone(input.targetNodeConfig);
  const workflowDefinition =
    input.workflowDefinition !== undefined
      ? structuredClone(input.workflowDefinition)
      : workflowDefinitionFromTarget(targetNodeConfig);
  const resolvedParentTasks = structuredClone(input.resolvedParentTasks);

  return {
    documentRevision: input.documentRevision ?? null,
    idempotencyKey,
    branchIndex: input.branchIndex,
    kind: "task-input-snapshot",
    nodeRunId: input.nodeRunId,
    nodeId: input.nodeId,
    providerInput: renderTaskProviderInput({
      idempotencyKey,
      branchIndex: input.branchIndex,
      materializedInputFacts: input.materializedInputFacts,
      resolvedParentTasks,
      targetNodeConfig,
      workflowDefinition,
    }).providerInput,
    resolvedParentTasks,
    targetNodeConfig,
    taskId: input.taskId,
    version: 1,
    workflowDefinition,
  };
}

export function isTaskInputSnapshot(
  value: unknown,
): value is TaskInputSnapshot {
  return (
    isRecord(value) &&
    value.kind === "task-input-snapshot" &&
    value.version === 1 &&
    (value.documentRevision === null ||
      typeof value.documentRevision === "number") &&
    typeof value.idempotencyKey === "string" &&
    typeof value.taskId === "string" &&
    typeof value.nodeRunId === "string" &&
    typeof value.nodeId === "string" &&
    typeof value.branchIndex === "number" &&
    isWorkflowDefinitionDocumentNode(value.targetNodeConfig) &&
    isWorkflowDefinitionGraphDocument(value.workflowDefinition) &&
    Array.isArray(value.resolvedParentTasks) &&
    value.resolvedParentTasks.every(isResolvedParentTaskInputSnapshot) &&
    isTaskProviderInput(value.providerInput)
  );
}

function workflowDefinitionFromTarget(
  targetNodeConfig: WorkflowDefinitionDocumentNode,
): WorkflowDefinitionGraphDocument {
  return {
    edges: [],
    nodes: [targetNodeConfig],
    version: WORKFLOW_DOCUMENT_VERSION,
  };
}

function isWorkflowDefinitionGraphDocument(
  value: unknown,
): value is WorkflowDefinitionGraphDocument {
  return (
    isRecord(value) &&
    value.version === WORKFLOW_DOCUMENT_VERSION &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isWorkflowDefinitionDocumentNode) &&
    Array.isArray(value.edges)
  );
}

function isResolvedParentTaskInputSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.nodeRunId === "string" &&
    typeof value.branchIndex === "number" &&
    isProviderDependencyAddress(value.address) &&
    (value.output === undefined || isRenderableTaskOutput(value.output)) &&
    (value.asset === undefined || isWorkflowAsset(value.asset))
  );
}

function isWorkflowAsset(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.kind === "image" ||
      value.kind === "video" ||
      value.kind === "text") &&
    typeof value.fileName === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.url === "string" &&
    typeof value.source === "string" &&
    typeof value.size === "number" &&
    typeof value.createdAt === "string" &&
    (value.storagePath === null || typeof value.storagePath === "string") &&
    (value.externalUri === null || typeof value.externalUri === "string") &&
    (value.model === null || typeof value.model === "string")
  );
}

function isTaskProviderInput(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }

  if (value.kind === "non-executable-node") {
    return (
      value.reason === "UNSUPPORTED_NODE_KIND" &&
      typeof value.message === "string"
    );
  }

  return (
    (value.kind === "image-generation-request" ||
      value.kind === "video-generation-request" ||
      value.kind === "llm-generation-request") &&
    isRecord(value.request) &&
    typeof value.request.model === "string" &&
    typeof value.request.prompt === "string"
  );
}

function isRenderableTaskOutput(value: unknown): boolean {
  return (
    isRecord(value) &&
    ((value.kind === "inline-text-asset" &&
      typeof value.assetId === "string" &&
      typeof value.text === "string") ||
      (value.kind === "cdn-asset" &&
        typeof value.assetId === "string" &&
        typeof value.cdnUrl === "string" &&
        typeof value.contentType === "string"))
  );
}

function isWorkflowDefinitionDocumentNode(
  value: unknown,
): value is WorkflowDefinitionDocumentNode {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    typeof value.label === "string" &&
    isRecord(value.position) &&
    typeof value.position.x === "number" &&
    typeof value.position.y === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
