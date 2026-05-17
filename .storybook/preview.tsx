import type { Decorator, Preview } from "@storybook/nextjs-vite";
import { initialize, mswLoader } from "msw-storybook-addon";
import { sb } from "storybook/test";

import "../src/styles/globals.css";

sb.mock(import("../src/main/trpc/react.tsx"));

import { TRPCReactProvider } from "~/main/trpc/react";

/*
 * Initializes MSW
 * See https://github.com/mswjs/msw-storybook-addon#configuring-msw
 * to learn how to customize it
 */
initialize();

const MockTRPCDecorator: Decorator = (Story) => (
  <TRPCReactProvider>
    <Story />
  </TRPCReactProvider>
);

const preview: Preview = {
  parameters: {
    darkMode: {
      // Set the initial theme
      current: "dark",
      stylePreview: true,
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },

    a11y: {
      // 'todo' - show a11y violations in the test UI only
      // 'error' - fail CI on a11y violations
      // 'off' - skip a11y checks entirely
      test: "todo",
    },
  },
  decorators: [MockTRPCDecorator],
  loaders: [mswLoader],
};

export default preview;
