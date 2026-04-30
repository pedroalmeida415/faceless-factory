import type { WorkflowDocument } from "~/lib/workflow/document";
import {
  type GeneratorIterationInfo,
  type WorkflowExecutionPlan,
  WorkflowExecutionPlanner,
} from "~/lib/workflow/execution/planning";

export type { GeneratorIterationInfo, WorkflowExecutionPlan };

export function buildWorkflowExecutionPlan(
  document: WorkflowDocument,
  targetNodeIds: string[],
): WorkflowExecutionPlan {
  return WorkflowExecutionPlanner.planTargetNodes(document, targetNodeIds);
}

export function getWorkflowPlannedOutputCount(
  document: WorkflowDocument,
  nodeId: string,
  sourceHandleId?: string | null,
  generatorIterationById: ReadonlyMap<
    string,
    { iterations: number }
  > = new Map(),
) {
  return WorkflowExecutionPlanner.getPlannedOutputCount({
    document,
    generatorIterationById,
    nodeId,
    sourceHandleId,
  });
}

export function getGeneratorIterationPreview(
  document: WorkflowDocument,
  targetId: string,
): GeneratorIterationInfo {
  return WorkflowExecutionPlanner.getGeneratorIterationPreview(
    document,
    targetId,
  );
}

export function collectWorkflowExecutionNodeIds(
  document: WorkflowDocument,
  targetNodeIds: string[],
) {
  return buildWorkflowExecutionPlan(document, targetNodeIds).requiredNodeIds;
}

export function extractWorkflowExecutionSubgraph(
  document: WorkflowDocument,
  targetNodeIds: string[],
): WorkflowDocument {
  return WorkflowExecutionPlanner.extractSubgraph(document, targetNodeIds);
}

export function collectExecutableWorkflowGeneratorNodeIds(
  document: WorkflowDocument,
  targetNodeIds: string[],
) {
  return buildWorkflowExecutionPlan(document, targetNodeIds).executableNodeIds;
}

export function collectDownstreamWorkflowGeneratorNodeIds(
  document: WorkflowDocument,
  sourceNodeId: string,
  allowedNodeIds?: ReadonlySet<string>,
) {
  return WorkflowExecutionPlanner.collectDownstreamGeneratorNodeIds({
    allowedNodeIds,
    document,
    sourceNodeId,
  });
}
