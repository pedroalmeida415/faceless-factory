"use client";

import { createContext, type ReactNode, useRef } from "react";
import { WorkflowAutosave } from "./workflow-autosave";
import { createWorkflowStore, type WorkflowStoreApi, type WorkflowStoreInitialState } from "./workflow-store";

export const WorkflowStoreContext = createContext<WorkflowStoreApi | null>(null);

export function WorkflowStoreProvider({
  children,
  initialState,
}: {
  readonly children: ReactNode;
  readonly initialState?: WorkflowStoreInitialState;
}) {
  const storeRef = useRef<WorkflowStoreApi | null>(null);

  if (!storeRef.current) {
    storeRef.current = createWorkflowStore(initialState);
  }

  return (
    <WorkflowStoreContext.Provider value={storeRef.current}>
      {children}
      <WorkflowAutosave />
    </WorkflowStoreContext.Provider>
  );
}
