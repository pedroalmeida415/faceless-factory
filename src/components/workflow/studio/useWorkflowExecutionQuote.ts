"use client";

import { useMemo } from "react";
import { useWorkflowStudioStore } from "~/components/workflow/studio/store";
import type { WorkflowExecutionPriceQuote } from "~/lib/workflow/pricing";
import { api } from "~/trpc/react";

export function useWorkflowExecutionQuote(nodeId: string) {
  const document = useWorkflowStudioStore((state) => state.document);
  const projectId = useWorkflowStudioStore((state) => state.projectId);

  const input = useMemo(
    () =>
      projectId
        ? {
            document,
            projectId,
            target: { type: "node", nodeId } as const,
          }
        : null,
    [document, nodeId, projectId],
  );
  const queryInput = input ?? {
    document,
    projectId: "",
    target: { type: "node", nodeId } as const,
  };

  const query = api.workflow.quoteExecution.useQuery(queryInput, {
    enabled: Boolean(input),
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });

  return {
    isLoading: query.isLoading,
    priceQuote: (query.data ?? null) as WorkflowExecutionPriceQuote | null,
  };
}
