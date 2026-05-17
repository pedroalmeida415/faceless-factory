"use client";

import { useMemo } from "react";
import { useWorkflowEvaluation } from "./use-workflow-evaluation";

export function useGenerationNodeEvaluation(nodeId: string | null) {
  const evaluation = useWorkflowEvaluation();

  return useMemo(
    () => (nodeId ? (evaluation.find((candidate) => candidate.nodeId === nodeId) ?? null) : null),
    [evaluation, nodeId],
  );
}
