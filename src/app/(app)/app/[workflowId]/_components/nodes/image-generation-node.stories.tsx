import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { WorkflowImageGenerationNode } from "~/features/workflow/domain/graph";
import { NANO_BANANA_PRO_MODEL } from "~/features/workflow/domain/model-catalog";
import {
  createWorkflowStoreInitialState,
  WORKFLOW_STORY_PARAMETERS,
  WorkflowStoreDecorator,
} from "../../_stories/decorators";
import { NodeEditor } from "../node-editor";
import NodeEditorStory, { type NodeEditorStoryArgs } from "../node-editor.stories";
import { WithAssets } from "./asset-node.stories";
import { Filled as PromptFilled } from "./prompt-node.stories";

const meta = {
  component: NodeEditor,
  decorators: [WorkflowStoreDecorator],
  parameters: {
    ...WORKFLOW_STORY_PARAMETERS,
    layout: "fullscreen",
  },
  render: NodeEditorStory.render,
  title: "Workflow/Components/Nodes/ImageGenerationNode",
} satisfies Meta<NodeEditorStoryArgs>;

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
  position: { x: 520, y: 220 },
  type: "imageGeneration",
} satisfies WorkflowImageGenerationNode;

const blockedImageGenerationNode = {
  ...imageGenerationNode,
  id: "image-generation-blocked",
} satisfies WorkflowImageGenerationNode;

const promptNodes = PromptFilled.args?.initialState?.graph?.nodes ?? [];
const assetNodes = WithAssets.args?.initialState?.graph?.nodes ?? [];

const readyGraph = {
  edges: [
    {
      id: "edge-prompt-image-generation",
      source: "prompt-1",
      target: imageGenerationNode.id,
      targetHandle: "prompt",
    },
    {
      id: "edge-asset-image-generation",
      source: "asset-1",
      target: imageGenerationNode.id,
      targetHandle: "image:0",
    },
  ],
  nodes: [...promptNodes, ...assetNodes, imageGenerationNode],
};

export const Ready = {
  args: {
    initialState: createWorkflowStoreInitialState(readyGraph),
  },
} satisfies Story;

export const Blocked = {
  args: {
    initialState: createWorkflowStoreInitialState({ edges: [], nodes: [blockedImageGenerationNode] }),
  },
} satisfies Story;

export const PendingEvaluation = {
  args: {
    initialState: createWorkflowStoreInitialState({ edges: [], nodes: [imageGenerationNode] }),
  },
} satisfies Story;
