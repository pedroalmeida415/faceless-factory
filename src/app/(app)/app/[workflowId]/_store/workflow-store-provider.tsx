"use client";

import { useParams } from "next/navigation";
import { createContext, type ReactNode, useEffect, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import { createWorkflowStore, type WorkflowStore, type WorkflowStoreInitialState } from "./workflow-store";

type WorkflowStoreApi = StoreApi<WorkflowStore>;

export const WorkflowStoreContext = createContext<WorkflowStoreApi | null>(null);

export function WorkflowStoreProvider({
  children,
  initialState,
}: {
  readonly children: ReactNode;
  readonly initialState?: WorkflowStoreInitialState;
}) {
  const storeRef = useRef<WorkflowStoreApi | null>(null);

  const { workflowId } = useParams<{ workflowId: string }>();

  if (!storeRef.current) {
    storeRef.current = createWorkflowStore(initialState, workflowId);
  }

  useEffect(() => {
    const store = storeRef.current;

    return () => store?.getState().dispose();
  }, []);

  return <WorkflowStoreContext.Provider value={storeRef.current}>{children}</WorkflowStoreContext.Provider>;
}
