import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import type { WorkflowPromptNode } from "~/features/workflow/domain/graph";
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
  title: "Workflow/Components/Nodes/PromptNode",
} satisfies Meta<NodeEditorStoryArgs>;

export default meta;

type Story = StoryObj<typeof meta>;

// Story fixtures
const promptNode = {
  data: {
    text: "A cinematic product shot of a translucent perfume bottle on wet black stone.",
  },
  id: "prompt-1",
  position: { x: 80, y: 120 },
  type: "prompt",
} satisfies WorkflowPromptNode;

const emptyPromptNode = {
  ...promptNode,
  data: { text: "" },
  id: "prompt-empty",
} satisfies WorkflowPromptNode;

export const Filled = {
  args: {
    initialState: createWorkflowStoreInitialState({ nodes: [promptNode] }),
  },
} satisfies Story;

export const Empty = {
  args: {
    initialState: createWorkflowStoreInitialState({ nodes: [emptyPromptNode] }),
  },
} satisfies Story;

export const CommitsOnBlur = {
  args: Filled.args,
  play: async (context) => {
    await NodeEditorStory.play(context);
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox");
    await expect(input).toHaveValue(promptNode.data.text);
    await userEvent.clear(input);
    await userEvent.type(input, "New product prompt");
    await expect(input).toHaveValue("New product prompt");
    await userEvent.tab();
    await expect(input).toHaveValue("New product prompt");
  },
} satisfies Story;
