import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ComponentProps } from "react";
import type { WorkflowImageGenerationNode } from "~/features/workflow/domain/graph";
import { NANO_BANANA_PRO_MODEL } from "~/features/workflow/domain/model-catalog";
import type { WorkflowStoreInitialState } from "../_store/workflow-store";
import {
  createWorkflowStoreInitialState,
  WORKFLOW_STORY_PARAMETERS,
  WorkflowStoreDecorator,
  type WorkflowStoreStoryArgs,
} from "../_stories/decorators";
import { NodeInspector } from "./node-inspector";

type NodeInspectorStoryArgs = ComponentProps<typeof NodeInspector> & WorkflowStoreStoryArgs;

const meta = {
  component: NodeInspector,
  decorators: [WorkflowStoreDecorator],
  parameters: WORKFLOW_STORY_PARAMETERS,
  title: "Workflow/Components/NodeInspector",
} satisfies Meta<NodeInspectorStoryArgs>;

export default meta;

type Story = StoryObj<typeof meta>;

// Story fixtures
const imageGenerationNode = {
  data: {
    branchBatchSize: 2,
    config: NANO_BANANA_PRO_MODEL.defaultConfig,
    modelId: NANO_BANANA_PRO_MODEL.modelId,
    selectedBatchItems: [],
  },
  id: "image-generation-1",
  position: { x: 0, y: 0 },
  type: "imageGeneration",
} satisfies WorkflowImageGenerationNode;

const selectedInspectorState = {
  graph: createWorkflowStoreInitialState({ nodes: [imageGenerationNode] }).graph,
  selectedGenerationNodeId: imageGenerationNode.id,
} satisfies WorkflowStoreInitialState;

export const ImageGenerationSelected = {
  args: {
    initialState: selectedInspectorState,
  },
} satisfies Story;

export const NoSelection = {
  args: {
    initialState: {
      graph: createWorkflowStoreInitialState({ nodes: [imageGenerationNode] }).graph,
      selectedGenerationNodeId: null,
    },
  },
} satisfies Story;
