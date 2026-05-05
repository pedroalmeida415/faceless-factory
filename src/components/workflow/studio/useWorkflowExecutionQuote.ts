"use client";

import { useWorkflowStudioStore } from "~/components/workflow/studio/store";
import { api } from "~/trpc/react";

export function useWorkflowExecutionQuote(nodeId: string) {
  const document = useWorkflowStudioStore((state) => state.document);
  const projectionQuery = api.workflowRuntime.executionCostProjection.useQuery(
    { document },
    { staleTime: 30_000 },
  );

  return {
    priceQuote: projectionQuery.data?.costsByNodeId[nodeId] ?? null,
  };
}
