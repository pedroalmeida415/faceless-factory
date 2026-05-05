"use client";

import { useMemo } from "react";
import { useWorkflowStudioStore } from "~/components/workflow/studio/store";
import { estimateWorkflowRuntimeNode } from "~/lib/workflow/pricing";

export function useWorkflowExecutionQuote(nodeId: string) {
  const document = useWorkflowStudioStore((state) => state.document);
  const localPriceQuote = useMemo(() => {
    try {
      return estimateWorkflowRuntimeNode({
        document,
        nodeId,
      });
    } catch {
      return null;
    }
  }, [document, nodeId]);

  return {
    priceQuote: localPriceQuote,
  };
}
