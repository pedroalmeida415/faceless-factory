import type { WorkflowDocument } from "~/lib/workflow/document";

export const DEFAULT_WORKFLOW_PROJECT_NAME = "Untitled workflow";

export type WorkflowProject = {
  id: string;
  name: string;
  document: WorkflowDocument;
  documentRevision: number;
};

export type WorkflowProjectSaveRequest = {
  projectId: string;
  document: WorkflowDocument;
  documentRevision: number;
};

export type WorkflowProjectSaveResponse = {
  projectId: string;
  documentRevision: number;
};
