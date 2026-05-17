import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ComponentProps } from "react";
import { expect, waitFor } from "storybook/test";
import type { WorkflowImageGenerationNode, WorkflowPromptNode } from "~/features/workflow/domain/graph";
import { NANO_BANANA_PRO_MODEL } from "~/features/workflow/domain/model-catalog";
import {
  createWorkflowStoreInitialState,
  WORKFLOW_STORY_PARAMETERS,
  WorkflowStoreDecorator,
  type WorkflowStoreStoryArgs,
} from "../_stories/decorators";
import { NodeEditor } from "./node-editor";

export type NodeEditorStoryArgs = ComponentProps<typeof NodeEditor> & WorkflowStoreStoryArgs;

const meta = {
  component: NodeEditor,
  decorators: [WorkflowStoreDecorator],
  parameters: {
    ...WORKFLOW_STORY_PARAMETERS,
    layout: "fullscreen",
  },
  play: async ({ args, canvasElement }) => {
    const nodeCount = args.initialState?.graph?.nodes.length ?? 0;

    if (nodeCount === 0) {
      await expect(canvasElement.querySelector(".react-flow")).toBeInTheDocument();
      return;
    }

    await waitFor(() => {
      const workflowNodes = [...canvasElement.querySelectorAll(".react-flow__node")];

      expect(workflowNodes).toHaveLength(nodeCount);
      expect(workflowNodes.every((node) => node instanceof HTMLElement && node.style.visibility !== "hidden")).toBe(
        true,
      );
    });
  },
  render: () => (
    <div className="h-screen w-screen overflow-hidden">
      <NodeEditor />
    </div>
  ),
  title: "Workflow/Components/NodeEditor",
} satisfies Meta<NodeEditorStoryArgs>;

export default meta;

type Story = StoryObj<typeof meta>;

// Story fixtures
const promptNode = {
  data: { text: "A cinematic product shot of a translucent perfume bottle on wet black stone." },
  id: "prompt-1",
  position: { x: 80, y: 120 },
  type: "prompt",
} satisfies WorkflowPromptNode;

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

const connectedGraph = {
  edges: [
    {
      id: "edge-prompt-image-generation",
      source: "prompt-1",
      target: "image-generation-1",
      targetHandle: "prompt",
    },
  ],
  nodes: [promptNode, imageGenerationNode],
};

export const ConnectedGraph = {
  args: {
    initialState: createWorkflowStoreInitialState(connectedGraph),
  },
} satisfies Story;

export const EmptyGraph = {
  args: {
    initialState: createWorkflowStoreInitialState({ edges: [], nodes: [] }),
  },
} satisfies Story;
