import {
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDefinitionDocumentNode,
  type WorkflowDefinitionGraphDocument,
} from "~/lib/workflow/document";
import type { WorkflowAsset } from "~/lib/workflow/types";
import {
  isProviderDependencyAddress,
  type ProviderDependencyAddress,
} from "~/lib/workflow-runtime/domain/provider-dependency-address";
import { buildTaskRunIdempotencyKey } from "~/lib/workflow-runtime/domain/task-run-state";
import {
  type RenderedTaskRunProviderInput,
  renderTaskRunProviderInput,
  type TaskRunProviderInput,
} from "~/lib/workflow-runtime/execution/provider-input-rendering";
import type { MaterializedProviderInputFacts } from "~/lib/workflow-runtime/materialization/task-run-input-materialization";
import type { RenderableTaskOutput } from "~/lib/workflow-runtime/runtime/task-status-events";

export type { RenderedTaskRunProviderInput, TaskRunProviderInput };

export type ResolvedParentTaskRunInputSnapshot = {
  readonly taskRunId: string;
  readonly nodeExecutionId: string;
  readonly itemIndex: number;
  readonly attempt: number;
  readonly address: ProviderDependencyAddress;
  readonly asset?: WorkflowAsset;
  readonly output?: RenderableTaskOutput;
};

export type TaskRunInputSnapshot = {
  readonly kind: "task-run-input-snapshot";
  readonly version: 1;
  readonly documentRevision: number | null;
  readonly taskRunId: string;
  readonly nodeExecutionId: string;
  readonly nodeId: string;
  readonly itemIndex: number;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly targetNodeConfig: WorkflowDefinitionDocumentNode;
  readonly workflowDefinition: WorkflowDefinitionGraphDocument;
  readonly resolvedParentTaskRuns: readonly ResolvedParentTaskRunInputSnapshot[];
  readonly providerInput: TaskRunProviderInput;
};

export type ExecutableTaskRunInputSnapshot = TaskRunInputSnapshot & {
  readonly providerInput: RenderedTaskRunProviderInput;
};

export function buildTaskRunInputSnapshot(input: {
  readonly taskRunId: string;
  readonly nodeExecutionId: string;
  readonly nodeId: string;
  readonly itemIndex: number;
  readonly attempt: number;
  readonly documentRevision?: number | null;
  readonly targetNodeConfig: WorkflowDefinitionDocumentNode;
  readonly workflowDefinition?: WorkflowDefinitionGraphDocument;
  readonly resolvedParentTaskRuns: readonly ResolvedParentTaskRunInputSnapshot[];
  readonly materializedInputFacts?: MaterializedProviderInputFacts;
}): TaskRunInputSnapshot {
  const idempotencyKey = buildTaskRunIdempotencyKey({
    attempt: input.attempt,
    taskRunId: input.taskRunId,
  });
  const targetNodeConfig = structuredClone(input.targetNodeConfig);
  const workflowDefinition =
    input.workflowDefinition !== undefined
      ? structuredClone(input.workflowDefinition)
      : workflowDefinitionFromTarget(targetNodeConfig);
  const resolvedParentTaskRuns = structuredClone(input.resolvedParentTaskRuns);

  return {
    attempt: input.attempt,
    documentRevision: input.documentRevision ?? null,
    idempotencyKey,
    itemIndex: input.itemIndex,
    kind: "task-run-input-snapshot",
    nodeExecutionId: input.nodeExecutionId,
    nodeId: input.nodeId,
    providerInput: renderTaskRunProviderInput({
      idempotencyKey,
      itemIndex: input.itemIndex,
      materializedInputFacts: input.materializedInputFacts,
      resolvedParentTaskRuns,
      targetNodeConfig,
      workflowDefinition,
    }).providerInput,
    resolvedParentTaskRuns,
    targetNodeConfig,
    taskRunId: input.taskRunId,
    version: 1,
    workflowDefinition,
  };
}

export function isTaskRunInputSnapshot(
  value: unknown,
): value is TaskRunInputSnapshot {
  return (
    isRecord(value) &&
    value.kind === "task-run-input-snapshot" &&
    value.version === 1 &&
    (value.documentRevision === null ||
      typeof value.documentRevision === "number") &&
    typeof value.idempotencyKey === "string" &&
    typeof value.taskRunId === "string" &&
    typeof value.nodeExecutionId === "string" &&
    typeof value.nodeId === "string" &&
    typeof value.itemIndex === "number" &&
    typeof value.attempt === "number" &&
    isWorkflowDefinitionDocumentNode(value.targetNodeConfig) &&
    isWorkflowDefinitionGraphDocument(value.workflowDefinition) &&
    Array.isArray(value.resolvedParentTaskRuns) &&
    value.resolvedParentTaskRuns.every(isResolvedParentTaskRunInputSnapshot) &&
    isTaskRunProviderInput(value.providerInput)
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

function isResolvedParentTaskRunInputSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.taskRunId === "string" &&
    typeof value.nodeExecutionId === "string" &&
    typeof value.itemIndex === "number" &&
    typeof value.attempt === "number" &&
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

function isTaskRunProviderInput(value: unknown): boolean {
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
