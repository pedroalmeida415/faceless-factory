import {
  extractTaskRunMaterializationSubgraph,
  type GeneratorIterationInfo,
  getGeneratorIterationPreview,
  planTargetNodes,
  type TaskRunMaterializationPlan,
} from "~/features/runtime/materialization/planning";
import type { WorkflowDocument } from "~/features/workflow/document";

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
