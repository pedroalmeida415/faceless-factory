"use client";

import { Effect } from "effect";

import type {
  WorkflowProjectSaveRequest,
  WorkflowProjectSaveResponse,
} from "~/lib/workflow/project";
import { WorkflowClientService } from "~/lib/workflow/services/workflow-client";

const WORKFLOW_SAVE_DEBOUNCE_MS = 800;

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
let isDirty = false;

function clearDebounceTimer() {
  if (debounceTimer === null) {
    return;
  }

  globalThis.clearTimeout(debounceTimer);
  debounceTimer = null;
}

async function runDrainLoop(): Promise<WorkflowProjectSaveResponse | null> {
  let lastResult: WorkflowProjectSaveResponse | null = null;

  while (config) {
    if (inFlightSave) {
      lastResult = await inFlightSave;
      continue;
    }

    if (!isDirty) {
      return lastResult;
    }

    const snapshot = config.getSnapshot();
    if (!snapshot) {
      isDirty = false;
      return lastResult;
    }

    isDirty = false;

    const pendingSave = Effect.runPromise(
      WorkflowClientService.saveProject(snapshot),
    );
    inFlightSave = pendingSave;

    try {
      const result = await pendingSave;
      lastResult = result;
      config?.onSaved(result);
    } catch (error) {
      config?.onError(error);
      throw error;
    } finally {
      if (inFlightSave === pendingSave) {
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

  drainPromise = runDrainLoop().finally(() => {
    drainPromise = null;
  });

  return drainPromise;
}

export const WorkflowPersistenceService = {
  configure(nextConfig: WorkflowPersistenceConfig) {
    config = nextConfig;
  },

  scheduleSave() {
    if (!config) {
      return;
    }

    isDirty = true;
    clearDebounceTimer();
    debounceTimer = globalThis.setTimeout(() => {
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
    return drainPendingSave();
  },

  reset() {
    clearDebounceTimer();
    config = null;
    drainPromise = null;
    inFlightSave = null;
    isDirty = false;
  },
};
