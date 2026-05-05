import {
  toWorkflowDefinitionGraphDocument,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import { extractTaskRunMaterializationSlice } from "~/lib/workflow/execution/subgraph";

const ACTIVE_TASK_RUN_SAVE_LOCK_MESSAGE =
  "Cannot edit nodes that are participating in a running workflow.";

type ActiveTaskRunSaveLockParams = {
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

export function assertActiveTaskRunSaveAllowed(
  params: ActiveTaskRunSaveLockParams,
) {
  if (!params.activeTargetNodeIds.length) {
    return;
  }

  const currentMaterializationSlice = materializationSemanticDocument(
    extractTaskRunMaterializationSlice(params.currentDocument, [
      ...params.activeTargetNodeIds,
    ]),
  );
  const nextMaterializationSlice = materializationSemanticDocument(
    extractTaskRunMaterializationSlice(params.nextDocument, [
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
