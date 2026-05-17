import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ComponentProps } from "react";
import { ConnectedGraph } from "./_components/node-editor.stories";
import { WORKFLOW_STORY_PARAMETERS, WorkflowStoreDecorator, type WorkflowStoreStoryArgs } from "./_stories/decorators";
import WorkflowPage from "./page";

type WorkflowPageStoryArgs = ComponentProps<typeof WorkflowPage> & WorkflowStoreStoryArgs;

const meta = {
  decorators: [WorkflowStoreDecorator],
  parameters: {
    ...WORKFLOW_STORY_PARAMETERS,
    layout: "fullscreen",
  },
  component: WorkflowPage,
  title: "Workflow/Page/Workflow",
} satisfies Meta<WorkflowPageStoryArgs>;

export default meta;

type Story = StoryObj<typeof meta>;

// Story fixtures
const connectedGraph = ConnectedGraph.args?.initialState?.graph;

export const Loaded = {
  args: {
    initialState: {
      graph: connectedGraph,
    },
  },
} satisfies Story;
