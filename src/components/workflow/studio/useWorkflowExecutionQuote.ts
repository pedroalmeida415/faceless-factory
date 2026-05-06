"use client";

import { api } from "~/client/trpc/react";
import { useWorkflowStudioStore } from "~/components/workflow/studio/store";

export function useWorkflowExecutionQuote(nodeId: string) {
  const projectId = useWorkflowStudioStore((state) => state.projectId);
  const projectionQuery = api.runtime.executionCostProjection.useQuery(
    { projectId: projectId ?? "" },
    { enabled: Boolean(projectId), staleTime: 30_000 },
  );

  return {
    priceQuote: projectionQuery.data?.costsByNodeId[nodeId] ?? null,
  };
}
