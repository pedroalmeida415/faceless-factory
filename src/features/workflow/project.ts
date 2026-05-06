import type { WorkflowGraphDocument } from "~/features/workflow/document";

export const DEFAULT_WORKFLOW_PROJECT_NAME = "Untitled workflow";

export type WorkflowProject = {
  id: string;
  name: string;
  document: WorkflowGraphDocument;
  documentRevision: number;
};

export type WorkflowProjectSaveRequest = {
  projectId: string;
  document: WorkflowGraphDocument;
  documentRevision: number;
};

export type WorkflowProjectSaveResponse = {
  documentRevision: number;
};
