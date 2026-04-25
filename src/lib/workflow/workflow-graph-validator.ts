import type { WorkflowDocument } from "~/lib/workflow/document";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import {
  buildIncomingByTarget,
  buildOutgoingBySource,
  getGeneratorInputHandles,
  getGeneratorIterationPreview,
  getIncomingEdgesForHandle,
  isValidWorkflowEdge,
  resolvePromptNodeTextBatch,
} from "~/lib/workflow/graph";
import { isGeneratorNodeKind } from "~/lib/workflow/types";

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

function validateExecutionSubgraph(
  document: WorkflowDocument,
  nodeId: string,
  visited: Set<string>,
  path: Set<string>,
) {
  if (path.has(nodeId)) {
    failValidation("Cycle detected in workflow graph.");
  }

  if (visited.has(nodeId)) {
    return;
  }

  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const incomingByTarget = buildIncomingByTarget(document.edges);
  const node = nodeMap.get(nodeId);

  if (!node) {
    failValidation(`Node ${nodeId} not found.`);
  }

  visited.add(nodeId);
  path.add(nodeId);

  switch (node.kind) {
    case "list":
      if (!node.items.some((value) => value.trim())) {
        failValidation("List node is empty.");
      }
      break;
    case "prompt":
      if (
        !resolvePromptNodeTextBatch(node, (key) =>
          getIncomingEdgesForHandle(incomingByTarget, node.id, key).length
            ? {
                type: "text",
                lanes: [key],
              }
            : null,
        )
      ) {
        failValidation("Prompt node is empty.");
      }
      break;
    case "asset":
      if (!node.assetKind || !node.assets.length) {
        failValidation("Asset node is empty.");
      }
      break;
    case "imageGenerator":
    case "videoGenerator":
    case "llmGenerator": {
      const requiredTextHandles = getGeneratorInputHandles(
        document,
        node.id,
      ).filter((handle) => handle.required && handle.valueType === "text");

      for (const handle of requiredTextHandles) {
        if (
          getIncomingEdgesForHandle(incomingByTarget, node.id, handle.id).length
        ) {
          continue;
        }

        failValidation(`Connect ${handle.label.toLowerCase()} text.`);
      }
      if (getGeneratorIterationPreview(document, node.id).mismatchedIterators) {
        failValidation("Connected input lane counts do not match.");
      }
      break;
    }
  }

  for (const edge of incomingByTarget.get(nodeId) ?? []) {
    validateExecutionSubgraph(document, edge.source, visited, new Set(path));
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

  validateQuoteTargets(document: WorkflowDocument, targetIds: string[]) {
    this.validateDocument(document);

    const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));

    for (const targetId of targetIds) {
      const targetNode = nodeMap.get(targetId);
      if (!targetNode) {
        failValidation(`Node ${targetId} not found.`);
      }

      if (!isGeneratorNodeKind(targetNode.kind)) {
        failValidation("Only generator nodes can be executed.");
      }
    }
  },

  validateExecutionTargets(document: WorkflowDocument, targetIds: string[]) {
    this.validateQuoteTargets(document, targetIds);

    const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
    const visited = new Set<string>();

    for (const targetId of targetIds) {
      const targetNode = nodeMap.get(targetId);
      if (!targetNode) {
        failValidation(`Node ${targetId} not found.`);
      }

      if (!isGeneratorNodeKind(targetNode.kind)) {
        failValidation("Only generator nodes can be executed.");
      }

      validateExecutionSubgraph(document, targetId, visited, new Set());
    }
  },
};
