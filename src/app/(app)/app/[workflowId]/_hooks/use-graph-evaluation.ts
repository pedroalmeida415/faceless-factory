"use client";

import { memoize } from "proxy-memoize";
import { evaluateWorkflowGraph } from "~/features/workflow/domain/graph-evaluation";
import type { WorkflowStore } from "../_store/workflow-store";
import { useWorkflowStore } from "./use-workflow-store";

const selectGraphEvaluation = memoize((store: WorkflowStore) =>
  evaluateWorkflowGraph({
    edges: store.edges,
    nodes: store.nodes,
  }),
);

export function useGraphEvaluation() {
  return useWorkflowStore(selectGraphEvaluation);
}
