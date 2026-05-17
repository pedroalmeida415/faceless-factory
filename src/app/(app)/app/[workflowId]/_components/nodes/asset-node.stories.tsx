import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import type { WorkflowAssetNode } from "~/features/workflow/domain/graph";
import {
  createWorkflowStoreInitialState,
  WORKFLOW_STORY_PARAMETERS,
  WorkflowStoreDecorator,
} from "../../_stories/decorators";
import { NodeEditor } from "../node-editor";
import NodeEditorStory, { type NodeEditorStoryArgs } from "../node-editor.stories";

const meta = {
  component: NodeEditor,
  decorators: [WorkflowStoreDecorator],
  parameters: {
    ...WORKFLOW_STORY_PARAMETERS,
    layout: "fullscreen",
  },
  render: NodeEditorStory.render,
  title: "Workflow/Components/Nodes/AssetNode",
} satisfies Meta<NodeEditorStoryArgs>;

export default meta;

type Story = StoryObj<typeof meta>;

// Story fixtures
const emptyAssetNode = {
  data: { assets: [] },
  id: "asset-empty",
  position: { x: 80, y: 600 },
  type: "asset",
} satisfies WorkflowAssetNode;

const assetNode = {
  data: {
    assets: [
      { assetId: "asset-1", name: "Bottle reference" },
      { assetId: "asset-2", name: "Stone texture" },
    ],
  },
  id: "asset-1",
  position: { x: 80, y: 600 },
  type: "asset",
} satisfies WorkflowAssetNode;

export const Empty = {
  args: {
    initialState: createWorkflowStoreInitialState({ nodes: [emptyAssetNode] }),
  },
} satisfies Story;

export const WithAssets = {
  args: {
    initialState: createWorkflowStoreInitialState({ nodes: [assetNode] }),
  },
} satisfies Story;

export const AddsMockAsset = {
  args: Empty.args,
  play: async (context) => {
    await NodeEditorStory.play(context);
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No assets yet.")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /add mock asset/i }));
    await expect(canvas.getByText("Reference 1")).toBeInTheDocument();
  },
} satisfies Story;
