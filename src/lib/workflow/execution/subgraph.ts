import type { WorkflowDocument } from "~/lib/workflow/document";
import { buildIncomingByTarget } from "~/lib/workflow/graph";

export function collectWorkflowExecutionNodeIds(
  document: WorkflowDocument,
  targetNodeIds: string[],
) {
  const requiredNodeIds = new Set<string>();
  const incomingByTarget = buildIncomingByTarget(document.edges);

  const visit = (nodeId: string) => {
    if (requiredNodeIds.has(nodeId)) {
      return;
    }

    requiredNodeIds.add(nodeId);

    for (const edge of incomingByTarget.get(nodeId) ?? []) {
      visit(edge.source);
    }
  };

  for (const targetNodeId of targetNodeIds) {
    visit(targetNodeId);
  }

  return requiredNodeIds;
}

export function extractWorkflowExecutionSubgraph(
  document: WorkflowDocument,
  targetNodeIds: string[],
): WorkflowDocument {
  const requiredNodeIds = collectWorkflowExecutionNodeIds(
    document,
    targetNodeIds,
  );

  return {
    ...document,
    nodes: document.nodes.filter((node) => requiredNodeIds.has(node.id)),
    edges: document.edges.filter(
      (edge) =>
        requiredNodeIds.has(edge.source) && requiredNodeIds.has(edge.target),
    ),
  };
}
