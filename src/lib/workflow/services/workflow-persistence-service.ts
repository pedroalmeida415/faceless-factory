"use client";

import {
  createDefaultWorkflowDocument,
  deserializeStoredWorkflowDocument,
  WORKFLOW_STORAGE_KEY,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";

export type WorkflowPersistenceLoadResult = {
  activity: string | null;
  document: WorkflowDocument;
};

function parseStoredDocument(raw: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function validateStoredDocument(document: WorkflowDocument) {
  WorkflowGraphValidator.validateDocument(document);
  return document;
}

export const WorkflowPersistenceService = {
  loadDocument(): WorkflowPersistenceLoadResult {
    if (typeof window === "undefined") {
      return {
        activity: null,
        document: createDefaultWorkflowDocument(),
      };
    }

    const raw = window.localStorage.getItem(WORKFLOW_STORAGE_KEY);
    if (!raw) {
      return {
        activity: null,
        document: createDefaultWorkflowDocument(),
      };
    }

    try {
      const parsed = parseStoredDocument(raw);
      const document = parsed
        ? deserializeStoredWorkflowDocument(parsed)
        : null;

      if (!document) {
        throw new Error("Saved workflow graph is incompatible.");
      }

      return {
        activity: null,
        document: validateStoredDocument(document),
      };
    } catch {
      window.localStorage.removeItem(WORKFLOW_STORAGE_KEY);

      return {
        activity: "Saved graph was incompatible and has been reset.",
        document: createDefaultWorkflowDocument(),
      };
    }
  },

  saveDocument(document: WorkflowDocument) {
    if (typeof window === "undefined") {
      return;
    }

    validateStoredDocument(document);
    window.localStorage.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify(document));
  },

  clearDocument() {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.removeItem(WORKFLOW_STORAGE_KEY);
  },
};
