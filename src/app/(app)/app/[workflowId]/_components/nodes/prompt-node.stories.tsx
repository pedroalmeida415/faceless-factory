import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import type { WorkflowPromptNode } from "~/features/workflow/domain/graph";
import { createPromptDocumentFromText } from "~/features/workflow/domain/nodes/prompt";
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
    document: createPromptDocumentFromText(
      "A cinematic product shot of a translucent perfume bottle on wet black stone.",
    ),
  },
  id: "prompt-1",
  position: { x: 80, y: 120 },
  type: "prompt",
} satisfies WorkflowPromptNode;

const emptyPromptNode = {
  ...promptNode,
  data: { document: createPromptDocumentFromText("") },
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
  play: async (context) => {
    await NodeEditorStory.play(context);
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox");
    const placeholderNode = input.querySelector(".is-editor-empty[data-placeholder]");

    await expect(placeholderNode).toHaveAttribute("data-placeholder", "Write a prompt. Type @ to reference variables.");
    await expect(placeholderNode).toBeInstanceOf(Element);
    if (!(placeholderNode instanceof Element)) {
      return;
    }
    await expect(window.getComputedStyle(placeholderNode, "::before").content).toBe(
      '"Write a prompt. Type @ to reference variables."',
    );
  },
} satisfies Story;

export const CommitsOnBlur = {
  args: Filled.args,
  play: async (context) => {
    await NodeEditorStory.play(context);
    const { canvasElement } = context;
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox");
    await expect(input).toHaveTextContent(
      "A cinematic product shot of a translucent perfume bottle on wet black stone.",
    );
    await userEvent.clear(input);
    await userEvent.type(input, "New product prompt");
    await expect(input).toHaveTextContent("New product prompt");
    await userEvent.tab();
    await expect(input).toHaveTextContent("New product prompt");
  },
} satisfies Story;
