import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import type { WorkflowListNode } from "~/features/workflow/domain/graph";
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
  title: "Workflow/Components/Nodes/ListNode",
} satisfies Meta<NodeEditorStoryArgs>;

export default meta;

type Story = StoryObj<typeof meta>;

// Story fixtures
const listNode = {
  data: {
    items: [
      { id: "item-1", text: "Noir editorial lighting" },
      { id: "item-2", text: "Chrome sci-fi tabletop" },
      { id: "item-3", text: "" },
    ],
  },
  id: "list-1",
  position: { x: 80, y: 360 },
  type: "list",
} satisfies WorkflowListNode;

const filledListNode = {
  ...listNode,
  data: { items: listNode.data.items.filter((item) => item.text.trim() !== "") },
  id: "list-filled",
} satisfies WorkflowListNode;

export const WithBlankListItem = {
  args: {
    initialState: createWorkflowStoreInitialState({ nodes: [listNode] }),
  },
} satisfies Story;

export const FilledItems = {
  args: {
    initialState: {
      graph: createWorkflowStoreInitialState({ nodes: [filledListNode] }).graph,
    },
  },
} satisfies Story;

export const FocusesExistingBlankBeforeAdding = {
  args: WithBlankListItem.args,
  play: async (context) => {
    await NodeEditorStory.play(context);
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("List item 1")).toHaveValue("Noir editorial lighting");
    await expect(canvas.getByLabelText("List item 3")).toHaveValue("");
    await userEvent.click(canvas.getByRole("button", { name: /add row/i }));
    await expect(canvas.getByLabelText("List item 3")).toHaveFocus();
  },
} satisfies Story;

export const CommitsListItemOnBlur = {
  args: FilledItems.args,
  play: async (context) => {
    await NodeEditorStory.play(context);
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText("List item 1");
    await userEvent.clear(input);
    await userEvent.type(input, "Softbox lighting");
    await userEvent.tab();
    await expect(input).toHaveValue("Softbox lighting");
  },
} satisfies Story;
