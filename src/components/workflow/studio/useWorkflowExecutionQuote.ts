"use client";

import { useMemo } from "react";
import { useWorkflowStudioStore } from "~/components/workflow/studio/store";
import { estimateWorkflowExecution } from "~/lib/workflow/pricing";
import { api } from "~/trpc/react";

export function useWorkflowExecutionQuote(nodeId: string) {
  const document = useWorkflowStudioStore((state) => state.document);
  const documentRevision = useWorkflowStudioStore(
    (state) => state.documentRevision,
  );
  const projectId = useWorkflowStudioStore((state) => state.projectId);
  const serverQuote = api.workflow.quoteExecution.useQuery(
    {
      documentRevision,
      projectId: projectId ?? "",
      target: { type: "node", nodeId },
    },
    {
      enabled: Boolean(projectId && documentRevision !== null),
      retry: false,
    },
  );

  const localPriceQuote = useMemo(() => {
    try {
      return estimateWorkflowExecution({
        document,
        target: { type: "node", nodeId },
      });
    } catch {
      return null;
    }
  }, [document, nodeId]);

  const priceQuote = projectId ? (serverQuote.data ?? null) : localPriceQuote;

  return {
    priceQuote,
  };
}
