"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { toPersistedWorkflowGraph } from "~/features/workflow/domain/graph";
import { api } from "~/main/trpc/react";
import { useWorkflowStore } from "../_hooks/use-workflow-store";

export function WorkflowAutosave() {
  const utils = api.useUtils();
  const store = useWorkflowStore();
  const { workflowId } = useParams<{ workflowId: string }>();
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveWorkflow = api.workflow.saveWorkflow.useMutation({
    onMutate: () => {
      store.getState().setSaveState("saving");
    },
    onSuccess: () => {
      store.getState().setSaveState("saved");
      void utils.workflow.getWorkflow.invalidate({ workflowId });
    },
    onError: () => store.getState().setSaveState("error"),
  });

  useEffect(() => {
    const unsubscribe = store.subscribe(
      (state) => [state.edges, state.nodes] as const,
      ([edges, nodes]) => {
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
        }

        saveTimeoutRef.current = setTimeout(() => {
          saveWorkflow.mutate({ graph: toPersistedWorkflowGraph({ edges, nodes }), workflowId });
        }, 700);
      },
      {
        equalityFn: ([previousEdges, previousNodes], [nextEdges, nextNodes]) =>
          previousEdges === nextEdges && previousNodes === nextNodes,
      },
    );

    return () => {
      unsubscribe();

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [store, workflowId, saveWorkflow]);

  return null;
}
