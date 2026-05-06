"use client";

import { useWorkflowStudioStore } from "~/components/workflow/studio/store";
import { api } from "~/trpc/react";

export function useWorkflowExecutionQuote(nodeId: string) {
  const projectId = useWorkflowStudioStore((state) => state.projectId);
  const projectionQuery = api.workflowRuntime.executionCostProjection.useQuery(
    { projectId: projectId ?? "" },
    { enabled: Boolean(projectId), staleTime: 30_000 },
  );

  return {
    priceQuote: projectionQuery.data?.costsByNodeId[nodeId] ?? null,
  };
}
