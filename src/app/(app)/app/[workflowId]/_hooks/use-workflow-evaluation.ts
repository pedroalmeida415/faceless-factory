"use client";

import { useMemo } from "react";
import { evaluateWorkflowGraph } from "~/features/workflow/domain/graph-evaluation";
import { useWorkflowStore } from "./use-workflow-store";

export function useWorkflowEvaluation() {
  const edges = useWorkflowStore((store) => store.edges);
  const nodes = useWorkflowStore((store) => store.nodes);

  return useMemo(() => evaluateWorkflowGraph({ edges, nodes }), [edges, nodes]);
}
