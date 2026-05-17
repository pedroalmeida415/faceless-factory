"use client";

import type { WorkflowImageGenerationNode } from "~/features/workflow/domain/graph";
import { useWorkflowStore } from "./use-workflow-store";

export function useSelectedGenerationNode() {
  return useWorkflowStore((store) => {
    const node = store.nodes.find(
      (candidate): candidate is WorkflowImageGenerationNode =>
        candidate.id === store.selectedGenerationNodeId && candidate.type === "imageGeneration",
    );

    return node;
  });
}
