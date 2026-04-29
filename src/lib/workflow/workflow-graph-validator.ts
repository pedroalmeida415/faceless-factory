import type { WorkflowDocument } from "~/lib/workflow/document";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import { buildWorkflowExecutionPlan } from "~/lib/workflow/execution/subgraph";
import {
  buildIncomingByTarget,
  buildOutgoingBySource,
  getGeneratorInputHandles,
  getIncomingEdgesForHandle,
  getOutputReorderInputValue,
  getOutputTransformInputValue,
  isValidWorkflowEdge,
  resolvePromptNodeTextBatch,
} from "~/lib/workflow/graph";
import {
  OUTPUT_REORDER_INPUT_HANDLE_ID,
  OUTPUT_TRANSFORM_INPUT_HANDLE_ID,
} from "~/lib/workflow/node-definitions";
import {
  getOutputPermutationValidationMessage,
  getOutputSelectionValidationMessage,
  getOutputSplitValidationMessage,
} from "~/lib/workflow/runtime-values";
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

function validateExecutionPlanNodes(
  document: WorkflowDocument,
  targetIds: string[],
) {
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const incomingByTarget = buildIncomingByTarget(document.edges);
  const executionPlan = buildWorkflowExecutionPlan(document, targetIds);
  const executableNodeIds = new Set(executionPlan.executableNodeIds);

  for (const nodeId of executionPlan.requiredNodeIds) {
    const node = nodeMap.get(nodeId);

    if (!node) {
      failValidation(`Node ${nodeId} not found.`);
    }

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
                  items: [key],
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
      case "outputReorder": {
        const inputEdges = getIncomingEdgesForHandle(
          incomingByTarget,
          node.id,
          OUTPUT_REORDER_INPUT_HANDLE_ID,
        );

        if (inputEdges.length !== 1) {
          failValidation("Output Reorder needs exactly one input.");
        }

        const inputValue = getOutputReorderInputValue(document, node.id);
        if (inputValue && inputValue.type !== node.valueType) {
          failValidation(
            "Output Reorder input type does not match its output type.",
          );
        }

        if (node.mode === "manual" && inputValue) {
          const message = getOutputPermutationValidationMessage(
            node.order,
            inputValue.items.length,
          );
          if (message) {
            failValidation(message);
          }
        }
        break;
      }
      case "outputSelect":
      case "outputSplit": {
        if (
          getIncomingEdgesForHandle(
            incomingByTarget,
            node.id,
            OUTPUT_TRANSFORM_INPUT_HANDLE_ID,
          ).length !== 1
        ) {
          failValidation(`${node.label} needs exactly one input.`);
        }

        const inputValue = getOutputTransformInputValue(document, node.id);
        if (inputValue && inputValue.type !== node.valueType) {
          failValidation(
            `${node.label} input type does not match its output type.`,
          );
        }

        if (node.kind === "outputSelect" && inputValue) {
          const message = getOutputSelectionValidationMessage(
            node.indices,
            inputValue.items.length,
          );
          if (message) {
            failValidation(message);
          }
        }

        if (node.kind === "outputSplit" && inputValue) {
          const message = getOutputSplitValidationMessage(
            node.splitCount,
            inputValue.items.length,
          );
          if (message) {
            failValidation(message);
          }
        }
        break;
      }
      case "outputMerge":
      case "outputZipAlign":
        if (
          !getIncomingEdgesForHandle(
            incomingByTarget,
            node.id,
            OUTPUT_TRANSFORM_INPUT_HANDLE_ID,
          ).length
        ) {
          failValidation(`${node.label} needs at least one input.`);
        }
        break;
      case "imageGenerator":
      case "videoGenerator":
      case "llmGenerator": {
        if (!executableNodeIds.has(node.id)) {
          break;
        }

        const requiredHandles = getGeneratorInputHandles(
          document,
          node.id,
        ).filter((handle) => handle.required);

        for (const handle of requiredHandles) {
          if (
            getIncomingEdgesForHandle(incomingByTarget, node.id, handle.id)
              .length
          ) {
            continue;
          }

          failValidation(
            `Connect ${handle.label.toLowerCase()} ${handle.valueType}.`,
          );
        }

        if (
          executionPlan.generatorIterationById.get(node.id)?.mismatchedIterators
        ) {
          failValidation("Connected input output counts do not match.");
        }
        break;
      }
    }
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
    validateExecutionPlanNodes(document, targetIds);
  },
};
