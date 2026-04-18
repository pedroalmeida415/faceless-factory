import type { Edge, Node } from "reactflow";

import type { WorkflowNodeData } from "~/lib/workflow/types";

export type WorkflowNode = Node<WorkflowNodeData>;
export type WorkflowEdge = Edge;

export type SavedWorkflowDocument = {
  version: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};
