import {
  toWorkflowDefinitionGraphDocument,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import { isGeneratorNodeKind } from "~/lib/workflow/types";
import {
  buildTaskRunInputSnapshot,
  type ExecutableTaskRunInputSnapshot,
} from "~/lib/workflow-runtime/execution/task-run-input-snapshot";

export type MaterializeTaskRunInputCommand = {
  readonly taskRunId: string;
  readonly nodeExecutionId: string;
  readonly nodeId: string;
  readonly itemIndex: number;
  readonly attempt: number;
  readonly document: WorkflowDocument;
  readonly documentRevision: number | null;
};

export type TaskRunInputMaterializationError = {
  readonly _tag: "TaskRunInputMaterializationError";
  readonly message: string;
};

export type TaskRunInputMaterializationResult =
  | { readonly ok: true; readonly value: ExecutableTaskRunInputSnapshot }
  | { readonly ok: false; readonly error: TaskRunInputMaterializationError };

export function materializeTaskRunInput(
  command: MaterializeTaskRunInputCommand,
): TaskRunInputMaterializationResult {
  const workflowDefinition = toWorkflowDefinitionGraphDocument(
    command.document,
  );
  const targetNodeConfig = workflowDefinition.nodes.find(
    (node) => node.id === command.nodeId,
  );
  if (!targetNodeConfig) {
    return materializationError(`Missing target node ${command.nodeId}.`);
  }
  if (!isGeneratorNodeKind(targetNodeConfig.kind)) {
    return materializationError(
      `Node kind ${targetNodeConfig.kind} is not executable by the provider runtime.`,
    );
  }

  try {
    const snapshot = buildTaskRunInputSnapshot({
      attempt: command.attempt,
      documentRevision: command.documentRevision,
      itemIndex: command.itemIndex,
      nodeExecutionId: command.nodeExecutionId,
      nodeId: command.nodeId,
      resolvedParentTaskRuns: [],
      targetNodeConfig,
      taskRunId: command.taskRunId,
      workflowDefinition,
    });
    if (snapshot.providerInput.kind === "non-executable-node") {
      return materializationError(snapshot.providerInput.message);
    }

    return {
      ok: true,
      value: { ...snapshot, providerInput: snapshot.providerInput },
    };
  } catch (cause) {
    return materializationError(
      cause instanceof Error && cause.message.length > 0
        ? cause.message
        : "Task Run Input Materialization failed.",
    );
  }
}

function materializationError(
  message: string,
): TaskRunInputMaterializationResult {
  return {
    error: { _tag: "TaskRunInputMaterializationError", message },
    ok: false,
  };
}
