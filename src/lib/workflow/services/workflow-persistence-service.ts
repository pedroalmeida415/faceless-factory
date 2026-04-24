"use client";

import { Effect } from "effect";

import type {
  WorkflowProjectSaveRequest,
  WorkflowProjectSaveResponse,
} from "~/lib/workflow/project";
import { WorkflowClientService } from "~/lib/workflow/services/workflow-client";

const WORKFLOW_SAVE_DEBOUNCE_MS = 1000;

type WorkflowPersistenceSnapshot = WorkflowProjectSaveRequest;

type WorkflowPersistenceConfig = {
  getSnapshot: () => WorkflowPersistenceSnapshot | null;
  onError: (error: unknown) => void;
  onSaved: (result: WorkflowProjectSaveResponse) => void;
};

let debounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let config: WorkflowPersistenceConfig | null = null;
let drainPromise: Promise<WorkflowProjectSaveResponse | null> | null = null;
let inFlightSave: Promise<WorkflowProjectSaveResponse> | null = null;
let pendingChangeId = 0;
let debouncedChangeId = 0;
let savedChangeId = 0;
let flushRequested = false;
let serviceGeneration = 0;

function clearDebounceTimer() {
  if (debounceTimer === null) {
    return;
  }

  globalThis.clearTimeout(debounceTimer);
  debounceTimer = null;
}

async function runDrainLoop(
  generation: number,
): Promise<WorkflowProjectSaveResponse | null> {
  let lastResult: WorkflowProjectSaveResponse | null = null;

  while (config && generation === serviceGeneration) {
    if (inFlightSave) {
      lastResult = await inFlightSave;
      continue;
    }

    const targetChangeId = flushRequested ? pendingChangeId : debouncedChangeId;

    if (savedChangeId >= targetChangeId) {
      flushRequested = false;
      return lastResult;
    }

    if (!flushRequested && debouncedChangeId !== pendingChangeId) {
      return lastResult;
    }

    const snapshot = config.getSnapshot();
    if (!snapshot) {
      savedChangeId = targetChangeId;
      flushRequested = false;
      return lastResult;
    }

    const pendingSave = Effect.runPromise(
      WorkflowClientService.saveProject(snapshot),
    );
    inFlightSave = pendingSave;

    try {
      const result = await pendingSave;
      if (generation !== serviceGeneration) {
        return lastResult;
      }

      lastResult = result;
      config?.onSaved(result);
      savedChangeId = targetChangeId;
      flushRequested = flushRequested && savedChangeId < pendingChangeId;
    } catch (error) {
      if (generation !== serviceGeneration) {
        return lastResult;
      }

      config?.onError(error);
      throw error;
    } finally {
      if (generation === serviceGeneration && inFlightSave === pendingSave) {
        inFlightSave = null;
      }
    }
  }

  return lastResult;
}

function drainPendingSave(): Promise<WorkflowProjectSaveResponse | null> {
  if (drainPromise) {
    return drainPromise;
  }

  const nextDrainPromise = runDrainLoop(serviceGeneration).finally(() => {
    if (drainPromise === nextDrainPromise) {
      drainPromise = null;
    }
  });
  drainPromise = nextDrainPromise;

  return drainPromise;
}

export const WorkflowPersistenceService = {
  configure(nextConfig: WorkflowPersistenceConfig) {
    serviceGeneration += 1;
    config = nextConfig;
  },

  scheduleSave() {
    if (!config) {
      return;
    }

    pendingChangeId += 1;
    clearDebounceTimer();
    debounceTimer = globalThis.setTimeout(() => {
      debounceTimer = null;
      debouncedChangeId = pendingChangeId;
      void drainPendingSave().catch(() => {
        return undefined;
      });
    }, WORKFLOW_SAVE_DEBOUNCE_MS);
  },

  async flushSave() {
    if (!config) {
      return null;
    }

    clearDebounceTimer();
    debouncedChangeId = pendingChangeId;
    flushRequested = true;
    return drainPendingSave();
  },

  reset() {
    serviceGeneration += 1;
    clearDebounceTimer();
    config = null;
    drainPromise = null;
    inFlightSave = null;
    pendingChangeId = 0;
    debouncedChangeId = 0;
    savedChangeId = 0;
    flushRequested = false;
  },
};
