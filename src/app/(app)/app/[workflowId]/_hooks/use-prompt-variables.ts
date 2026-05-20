"use client";

import { memoize } from "proxy-memoize";
import { getWorkflowPromptVariables, type WorkflowPromptVariable } from "~/features/workflow/domain/nodes/prompt";
import type { WorkflowStore } from "../_store/workflow-store";
import { useWorkflowStore } from "./use-workflow-store";

const EMPTY_PROMPT_VARIABLES: readonly WorkflowPromptVariable[] = [];

const selectPromptVariablesByNodeId = memoize((store: WorkflowStore) => {
  const variablesByNodeId = new Map<string, readonly WorkflowPromptVariable[]>();

  for (const node of store.nodes) {
    if (node.type === "prompt") {
      variablesByNodeId.set(
        node.id,
        getWorkflowPromptVariables({
          edges: store.edges,
          nodes: store.nodes,
          promptNodeId: node.id,
        }),
      );
    }
  }

  return variablesByNodeId;
});

export function usePromptVariables(promptNodeId: string) {
  return useWorkflowStore(selectPromptVariablesByNodeId).get(promptNodeId) ?? EMPTY_PROMPT_VARIABLES;
}
