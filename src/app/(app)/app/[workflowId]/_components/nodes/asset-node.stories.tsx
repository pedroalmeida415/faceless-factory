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
      {
        assetId: "asset-1",
        height: 720,
        mediaType: "image",
        mimeType: "image/png",
        name: "Bottle reference",
        previewUrl: "https://placehold.co/1280x720/png",
        sizeBytes: 2_800_000,
        width: 1280,
      },
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

export const OpensUploadDialog = {
  args: Empty.args,
  play: async (context) => {
    await NodeEditorStory.play(context);
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /add media/i })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /add media/i }));
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("dialog", { name: /add media/i }),
    ).toBeInTheDocument();
  },
} satisfies Story;
