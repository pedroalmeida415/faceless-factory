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
  const localDocumentVersion = useWorkflowStudioStore(
    (state) => state.localDocumentVersion,
  );
  const savedLocalDocumentVersion = useWorkflowStudioStore(
    (state) => state.savedLocalDocumentVersion,
  );
  const projectId = useWorkflowStudioStore((state) => state.projectId);
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
  const canUseServerQuote = Boolean(
    projectId &&
      documentRevision !== null &&
      localDocumentVersion === savedLocalDocumentVersion &&
      localPriceQuote,
  );
  const serverQuote = api.workflow.quoteExecution.useQuery(
    {
      documentRevision,
      projectId: projectId ?? "",
      target: { type: "node", nodeId },
    },
    {
      enabled: canUseServerQuote,
      retry: false,
    },
  );

  const priceQuote = canUseServerQuote
    ? (serverQuote.data ?? localPriceQuote)
    : localPriceQuote;

  return {
    priceQuote,
  };
}
