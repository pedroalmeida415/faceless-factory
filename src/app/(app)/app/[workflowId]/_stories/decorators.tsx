import type { Decorator } from "@storybook/nextjs-vite";
import { ReactFlowProvider } from "@xyflow/react";
import { createWorkflowGraph, type WorkflowGraph } from "~/features/workflow/domain/graph";
import type { WorkflowStoreInitialState } from "../_store/workflow-store";
import { WorkflowStoreProvider } from "../_store/workflow-store-provider";

export type WorkflowStoreStoryArgs = {
  readonly initialState?: WorkflowStoreInitialState;
};

export const WORKFLOW_STORY_PARAMETERS = {
  nextjs: {
    appDirectory: true,
    navigation: {
      segments: [["workflowId", "workflow-story"]],
    },
  },
} as const;

export function createWorkflowStoreInitialState({
  edges = [],
  nodes = [],
  selectedGenerationNodeId,
}: Partial<Pick<WorkflowGraph, "edges" | "nodes">> &
  Pick<WorkflowStoreInitialState, "selectedGenerationNodeId">): WorkflowStoreInitialState {
  return {
    graph: createWorkflowGraph({ edges, nodes }),
    selectedGenerationNodeId,
  };
}

export const WorkflowStoreDecorator: Decorator<WorkflowStoreStoryArgs> = (Story, { args }) => (
  <WorkflowStoreProvider initialState={args.initialState}>
    <Story />
  </WorkflowStoreProvider>
);

export const ReactFlowDecorator: Decorator = (Story) => (
  <ReactFlowProvider>
    <Story />
  </ReactFlowProvider>
);
