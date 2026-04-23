"use client";

import { useMemo } from "react";
import { useWorkflowStudioStore } from "~/components/workflow/studio/store";
import { estimateWorkflowExecution } from "~/lib/workflow/pricing";

export function useWorkflowExecutionQuote(nodeId: string) {
  const document = useWorkflowStudioStore((state) => state.document);

  const priceQuote = useMemo(() => {
    try {
      return estimateWorkflowExecution({
        document,
        target: { type: "node", nodeId },
      });
    } catch {
      return null;
    }
  }, [document, nodeId]);

  return {
    priceQuote,
  };
}
