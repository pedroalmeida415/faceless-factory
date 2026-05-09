import {
  extractTaskMaterializationSubgraph,
  type GeneratorIterationInfo,
  getGeneratorIterationPreview,
  planTargetNodes,
  type TaskMaterializationPlan,
} from "~/features/runtime/materialization/planning";
import type { WorkflowDocument } from "~/features/workflow/document";

export type { GeneratorIterationInfo, TaskMaterializationPlan };

export { getGeneratorIterationPreview };

function buildTaskMaterializationPlan(
  document: WorkflowDocument,
  targetNodeIds: string[],
): TaskMaterializationPlan {
  return planTargetNodes(document, targetNodeIds);
}

export function collectTaskMaterializationNodeIds(
  document: WorkflowDocument,
  targetNodeIds: string[],
) {
  return buildTaskMaterializationPlan(document, targetNodeIds).requiredNodeIds;
}

export function extractTaskMaterializationSlice(
  document: WorkflowDocument,
  targetNodeIds: string[],
): WorkflowDocument {
  return extractTaskMaterializationSubgraph(document, targetNodeIds);
}
