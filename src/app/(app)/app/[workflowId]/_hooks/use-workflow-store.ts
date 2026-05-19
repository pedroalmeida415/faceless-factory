"use client";

import { useContext } from "react";
import { useStore } from "zustand";
import type { WorkflowStore, WorkflowStoreApi } from "../_store/workflow-store";
import { WorkflowStoreContext } from "../_store/workflow-store-provider";

export function useWorkflowStore(): WorkflowStoreApi;
export function useWorkflowStore<T>(selector: (store: WorkflowStore) => T): T;
export function useWorkflowStore<T>(selector?: (store: WorkflowStore) => T): T | WorkflowStoreApi {
  const store = useContext(WorkflowStoreContext);

  if (!store) {
    throw new Error("useWorkflowStore must be used within WorkflowStoreProvider");
  }

  // biome-ignore lint/correctness/useHookAtTopLevel: overloaded hook
  return selector ? useStore(store, selector) : store;
}
