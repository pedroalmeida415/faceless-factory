"use client";

import { useContext } from "react";
import { useStore } from "zustand";
import type { WorkflowStore } from "../_store/workflow-store";
import { WorkflowStoreContext } from "../_store/workflow-store-provider";

export function useWorkflowStore<T>(selector: (store: WorkflowStore) => T): T {
  const store = useContext(WorkflowStoreContext);

  if (!store) {
    throw new Error("useWorkflowStore must be used within WorkflowStoreProvider");
  }

  return useStore(store, selector);
}
