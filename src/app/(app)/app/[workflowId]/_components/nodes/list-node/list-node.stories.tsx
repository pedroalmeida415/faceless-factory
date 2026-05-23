import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import type { WorkflowListNode } from "~/features/workflow/domain/graph";
import {
  createWorkflowStoreInitialState,
  WORKFLOW_STORY_PARAMETERS,
  WorkflowStoreDecorator,
} from "../../../_stories/decorators";
import { NodeEditor } from "../../node-editor";
import NodeEditorStory, { type NodeEditorStoryArgs } from "../../node-editor.stories";

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

const emptyListNode = {
  data: {
    items: [],
    mode: null,
  },
  id: "list-empty",
  position: { x: 80, y: 160 },
  type: "list",
} satisfies WorkflowListNode;

const textListNode = {
  data: {
    items: [
      { id: "item-1", text: "List text #1" },
      { id: "item-2", text: "List Text #2" },
      { id: "item-3", text: "List Item #3" },
    ],
    mode: "text",
  },
  id: "list-text",
  position: { x: 80, y: 160 },
  type: "list",
} satisfies WorkflowListNode;

const textListNodeWithBlank = {
  ...textListNode,
  data: {
    items: [...textListNode.data.items, { id: "item-4", text: "" }],
    mode: "text",
  },
  id: "list-text-with-blank",
} satisfies WorkflowListNode;

export const Empty = {
  args: {
    initialState: createWorkflowStoreInitialState({ nodes: [emptyListNode] }),
  },
} satisfies Story;

export const TextMode = {
  args: {
    initialState: createWorkflowStoreInitialState({ nodes: [textListNode] }),
  },
} satisfies Story;

export const AddTextStartsEditing = {
  args: Empty.args,
  play: async (context) => {
    await NodeEditorStory.play(context);
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /add text/i }));
    await expect(canvas.getByLabelText("List item 1 text")).toHaveFocus();
  },
} satisfies Story;

export const FocusesExistingBlankBeforeAdding = {
  args: {
    initialState: createWorkflowStoreInitialState({ nodes: [textListNodeWithBlank] }),
  },
  play: async (context) => {
    await NodeEditorStory.play(context);
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /add list item/i }));
    await expect(canvas.getByLabelText("List item 4 text")).toHaveFocus();
  },
} satisfies Story;

export const CommitsListItemOnBlur = {
  args: TextMode.args,
  play: async (context) => {
    await NodeEditorStory.play(context);
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByText("List text #1"));
    await userEvent.click(canvas.getByRole("button", { name: /edit list item 1/i }));
    const textarea = canvas.getByLabelText("List item 1 text");
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "Softbox lighting");
    await userEvent.click(canvas.getByTestId("workflow-surface"));
    await expect(canvas.getByText("Softbox lighting")).toBeInTheDocument();
  },
} satisfies Story;
