"use client";

import { memoize } from "proxy-memoize";
import {
  evaluateGenerationNode,
  type WorkflowGenerationNodeEvaluation,
} from "~/features/workflow/domain/graph-evaluation";
import type { WorkflowStore } from "../_store/workflow-store";
import { useWorkflowStore } from "./use-workflow-store";

const selectGenerationNodeEvaluationsById = memoize((store: WorkflowStore) => {
  const evaluationsById = new Map<string, WorkflowGenerationNodeEvaluation>();

  for (const node of store.nodes) {
    if (node.type === "imageGeneration") {
      evaluationsById.set(
        node.id,
        evaluateGenerationNode({
          blueprint: { edges: store.edges, nodes: store.nodes },
          nodeId: node.id,
        }),
      );
    }
  }

  return evaluationsById;
});

export function useGenerationNodeEvaluation(nodeId: string | null) {
  const evaluationsById = useWorkflowStore(selectGenerationNodeEvaluationsById);

  return nodeId ? (evaluationsById.get(nodeId) ?? null) : null;
}
