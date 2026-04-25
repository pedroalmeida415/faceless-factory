import type { WorkflowDocument } from "~/lib/workflow/document";
import {
  buildIncomingByTarget,
  getWorkflowGeneratorOutputRuntimeValue,
} from "~/lib/workflow/graph";
import { isGeneratorNodeKind } from "~/lib/workflow/types";

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

export function collectExecutableWorkflowGeneratorNodeIds(
  document: WorkflowDocument,
  targetNodeIds: string[],
) {
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const incomingByTarget = buildIncomingByTarget(document.edges);
  const targetSet = new Set(targetNodeIds);
  const executableNodeIds = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeId: string) => {
    if (visited.has(nodeId)) {
      return;
    }

    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) {
      return;
    }

    if (isGeneratorNodeKind(node.kind)) {
      if (
        getWorkflowGeneratorOutputRuntimeValue(node) &&
        !targetSet.has(node.id)
      ) {
        return;
      }

      executableNodeIds.add(node.id);
    }

    for (const edge of incomingByTarget.get(nodeId) ?? []) {
      visit(edge.source);
    }
  };

  for (const targetNodeId of targetNodeIds) {
    visit(targetNodeId);
  }

  return [...executableNodeIds];
}
