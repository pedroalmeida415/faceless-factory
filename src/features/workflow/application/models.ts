import type { WorkflowGraphBlueprint } from "~/features/workflow/domain/graph-blueprint";
import {
  evaluateWorkflowGraph,
  type WorkflowGenerationNodeEvaluation,
} from "~/features/workflow/domain/graph-evaluation";

export type WorkflowGraphProjection = {
  readonly evaluation: readonly WorkflowGenerationNodeEvaluation[];
  readonly graph: WorkflowGraphBlueprint;
  readonly name: string;
  readonly workflowId: string;
};

export type WorkflowSummaryProjection = {
  readonly name: string;
  readonly updatedAt: Date;
  readonly workflowId: string;
};

export function toWorkflowGraphProjection(input: {
  readonly graph: WorkflowGraphBlueprint;
  readonly name: string;
  readonly workflowId: string;
}): WorkflowGraphProjection {
  return {
    evaluation: evaluateWorkflowGraph(input.graph),
    graph: input.graph,
    name: input.name,
    workflowId: input.workflowId,
  };
}
