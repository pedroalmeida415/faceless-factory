import type { WorkflowDocument } from "~/lib/workflow/document";
import {
  extractTaskRunMaterializationSubgraph,
  type GeneratorIterationInfo,
  getGeneratorIterationPreview,
  planTargetNodes,
  type TaskRunMaterializationPlan,
} from "~/lib/workflow/execution/planning";

export type { GeneratorIterationInfo, TaskRunMaterializationPlan };

export { getGeneratorIterationPreview };

function buildTaskRunMaterializationPlan(
  document: WorkflowDocument,
  targetNodeIds: string[],
): TaskRunMaterializationPlan {
  return planTargetNodes(document, targetNodeIds);
}

export function collectTaskRunMaterializationNodeIds(
  document: WorkflowDocument,
  targetNodeIds: string[],
) {
  return buildTaskRunMaterializationPlan(document, targetNodeIds)
    .requiredNodeIds;
}

export function extractTaskRunMaterializationSlice(
  document: WorkflowDocument,
  targetNodeIds: string[],
): WorkflowDocument {
  return extractTaskRunMaterializationSubgraph(document, targetNodeIds);
}
