import type { WorkflowDocument } from "~/lib/workflow/document";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import {
  buildOutgoingBySource,
  isValidWorkflowEdge,
} from "~/lib/workflow/graph";

function failValidation(message: string): never {
  throw new WorkflowValidationError({ message });
}

function validateDocumentAcyclic(document: WorkflowDocument) {
  const outgoingBySource = buildOutgoingBySource(document.edges);
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visitNode = (nodeId: string) => {
    if (visiting.has(nodeId)) {
      failValidation("Cycle detected in workflow graph.");
    }

    if (visited.has(nodeId)) {
      return;
    }

    visiting.add(nodeId);
    for (const edge of outgoingBySource.get(nodeId) ?? []) {
      visitNode(edge.target);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  for (const node of document.nodes) {
    visitNode(node.id);
  }
}

export const WorkflowGraphValidator = {
  validateDocument(document: WorkflowDocument) {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const connectionKeys = new Set<string>();
    const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));

    for (const node of document.nodes) {
      if (nodeIds.has(node.id)) {
        failValidation(`Duplicate node id: ${node.id}.`);
      }
      nodeIds.add(node.id);
    }

    for (const edge of document.edges) {
      if (edgeIds.has(edge.id)) {
        failValidation(`Duplicate edge id: ${edge.id}.`);
      }
      edgeIds.add(edge.id);

      const connectionKey = [
        edge.source,
        edge.sourceHandle ?? "",
        edge.target,
        edge.targetHandle ?? "",
      ].join("::");

      if (connectionKeys.has(connectionKey)) {
        failValidation("Workflow contains a duplicate connection.");
      }
      connectionKeys.add(connectionKey);

      if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) {
        failValidation("Workflow contains a connection to a missing node.");
      }

      if (!isValidWorkflowEdge(document, edge)) {
        failValidation("Workflow contains an invalid connection.");
      }
    }

    validateDocumentAcyclic(document);
  },
};
