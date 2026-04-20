import type { WorkflowDocument } from "~/lib/workflow/document";
import type { WorkflowExecutionTarget } from "~/lib/workflow/execution/types";
import { isGeneratorNodeKind } from "~/lib/workflow/types";

export function resolveWorkflowExecutionTargets(
  document: WorkflowDocument,
  selectionNodeIds: string[],
  target: WorkflowExecutionTarget,
) {
  if (target.type === "node") {
    return [target.nodeId];
  }

  const selectedSet = new Set(selectionNodeIds);
  const selectedGeneratorIds = document.nodes
    .filter(
      (node) => selectedSet.has(node.id) && isGeneratorNodeKind(node.kind),
    )
    .map((node) => node.id);

  if (selectedGeneratorIds.length) {
    return selectedGeneratorIds;
  }

  return document.nodes
    .filter((node) => isGeneratorNodeKind(node.kind))
    .map((node) => node.id);
}
