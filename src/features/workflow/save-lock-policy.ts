import { extractTaskMaterializationSlice } from "~/features/runtime/materialization/subgraph";
import {
  toWorkflowDefinitionGraphDocument,
  type WorkflowDocument,
} from "~/features/workflow/document";
import { WorkflowValidationError } from "~/features/workflow/errors";

const ACTIVE_TASK_RUN_SAVE_LOCK_MESSAGE =
  "Cannot edit nodes that are participating in a running workflow.";

type ActiveTaskSaveLockParams = {
  readonly activeTargetNodeIds: readonly string[];
  readonly currentDocument: WorkflowDocument;
  readonly nextDocument: WorkflowDocument;
};

function materializationSemanticDocument(document: WorkflowDocument) {
  const definitionDocument = toWorkflowDefinitionGraphDocument(document);

  return {
    ...definitionDocument,
    nodes: definitionDocument.nodes.map(({ position, ...node }) => {
      void position;
      return node;
    }),
  };
}

export function assertActiveTaskSaveAllowed(params: ActiveTaskSaveLockParams) {
  if (!params.activeTargetNodeIds.length) {
    return;
  }

  const currentMaterializationSlice = materializationSemanticDocument(
    extractTaskMaterializationSlice(params.currentDocument, [
      ...params.activeTargetNodeIds,
    ]),
  );
  const nextMaterializationSlice = materializationSemanticDocument(
    extractTaskMaterializationSlice(params.nextDocument, [
      ...params.activeTargetNodeIds,
    ]),
  );

  if (
    JSON.stringify(currentMaterializationSlice) ===
    JSON.stringify(nextMaterializationSlice)
  ) {
    return;
  }

  throw new WorkflowValidationError({
    message: ACTIVE_TASK_RUN_SAVE_LOCK_MESSAGE,
  });
}
