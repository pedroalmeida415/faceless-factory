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
let inFlightSave: Promise<WorkflowProjectSaveResponse> | null = null;
let isDirty = false;

function clearDebounceTimer() {
  if (debounceTimer === null) {
    return;
  }

  globalThis.clearTimeout(debounceTimer);
  debounceTimer = null;
}

async function drainPendingSave(): Promise<WorkflowProjectSaveResponse | null> {
  if (!config) {
    return null;
  }

  if (inFlightSave) {
    const result = await inFlightSave;
    return isDirty ? ((await drainPendingSave()) ?? result) : result;
  }

  if (!isDirty) {
    return null;
  }

  const snapshot = config.getSnapshot();
  if (!snapshot) {
    isDirty = false;
    return null;
  }

  isDirty = false;
  inFlightSave = Effect.runPromise(WorkflowClientService.saveProject(snapshot));

  try {
    const result = await inFlightSave;
    config?.onSaved(result);
    return isDirty ? ((await drainPendingSave()) ?? result) : result;
  } catch (error) {
    config?.onError(error);
    throw error;
  } finally {
    inFlightSave = null;
  }
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
    inFlightSave = null;
    isDirty = false;
  },
};
