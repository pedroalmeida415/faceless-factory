"use client";

import { useEffect, useMemo, useState } from "react";
import { useWorkflowStudioStore } from "~/components/workflow/studio/store";
import type {
  WorkflowDocument,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { extractWorkflowExecutionSubgraph } from "~/lib/workflow/execution/subgraph";
import type { WorkflowExecutionPriceQuote } from "~/lib/workflow/pricing";
import { api } from "~/trpc/react";

const QUOTE_NODE_POSITION = { x: 0, y: 0 };
const WORKFLOW_EXECUTION_QUOTE_DEBOUNCE_MS = 1000;

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    if (Object.is(value, debouncedValue)) {
      return;
    }

    if (value === null) {
      setDebouncedValue(value);
      return;
    }

    const timer = globalThis.setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      globalThis.clearTimeout(timer);
    };
  }, [debouncedValue, delayMs, value]);

  return debouncedValue;
}

function sanitizeQuoteNode(
  node: WorkflowDocumentNode,
  targetNodeId: string,
): WorkflowDocumentNode {
  switch (node.kind) {
    case "prompt":
      return {
        ...node,
        label: "",
        position: QUOTE_NODE_POSITION,
      };
    case "asset":
      return {
        ...node,
        label: "",
        position: QUOTE_NODE_POSITION,
      };
    case "imageGenerator":
      return {
        ...node,
        config: {},
        lastPrompt: "",
        label: "",
        outputAssets: node.id === targetNodeId ? [] : node.outputAssets,
        position: QUOTE_NODE_POSITION,
        responseText: null,
      };
    case "videoGenerator":
      return {
        ...node,
        config: {},
        lastPrompt: "",
        label: "",
        outputAssets: node.id === targetNodeId ? [] : node.outputAssets,
        position: QUOTE_NODE_POSITION,
        responseText: null,
      };
    case "llmGenerator":
      return {
        ...node,
        config: {},
        lastPrompt: "",
        lastSystemPrompt: "",
        label: "",
        position: QUOTE_NODE_POSITION,
        responseText: node.id === targetNodeId ? null : node.responseText,
      };
  }
}

function buildQuoteDocument(
  document: WorkflowDocument,
  nodeId: string,
): WorkflowDocument {
  const subgraph = extractWorkflowExecutionSubgraph(document, [nodeId]);

  return {
    ...subgraph,
    // Keep the query key tied to quote-relevant execution inputs only.
    nodes: subgraph.nodes.map((node) => sanitizeQuoteNode(node, nodeId)),
  };
}

export function useWorkflowExecutionQuote(nodeId: string) {
  const document = useWorkflowStudioStore((state) => state.document);
  const projectId = useWorkflowStudioStore((state) => state.projectId);
  const quoteDocument = useMemo(
    () => buildQuoteDocument(document, nodeId),
    [document, nodeId],
  );

  const input = useMemo(
    () =>
      projectId
        ? {
            document: quoteDocument,
            projectId,
            target: { type: "node", nodeId } as const,
          }
        : null,
    [nodeId, projectId, quoteDocument],
  );
  const debouncedInput = useDebouncedValue(
    input,
    WORKFLOW_EXECUTION_QUOTE_DEBOUNCE_MS,
  );
  const queryInput = debouncedInput ?? {
    document: quoteDocument,
    projectId: "",
    target: { type: "node", nodeId } as const,
  };

  const query = api.workflow.quoteExecution.useQuery(queryInput, {
    enabled: Boolean(debouncedInput),
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });

  return {
    isLoading: query.isLoading,
    priceQuote: (query.data ?? null) as WorkflowExecutionPriceQuote | null,
  };
}
