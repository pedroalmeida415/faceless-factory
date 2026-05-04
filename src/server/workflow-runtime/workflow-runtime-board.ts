import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { getWorkflowRuntimeQueue } from "~/server/workflow-runtime/workflow-runtime-composition";

export const WORKFLOW_RUNTIME_BOARD_BASE_PATH = "/admin/queues";

const globalForWorkflowRuntimeBoard = globalThis as typeof globalThis & {
  __workflowRuntimeBoardApp?: Hono;
};

export function getWorkflowRuntimeBoardApp() {
  globalForWorkflowRuntimeBoard.__workflowRuntimeBoardApp ??=
    createWorkflowRuntimeBoardApp();

  return globalForWorkflowRuntimeBoard.__workflowRuntimeBoardApp;
}

function createWorkflowRuntimeBoardApp() {
  const boardApp = new Hono();
  const serverAdapter = new HonoAdapter(serveStatic).setBasePath(
    WORKFLOW_RUNTIME_BOARD_BASE_PATH,
  );

  createBullBoard({
    options: {
      uiConfig: {
        boardTitle: "Faceless Factory Queues",
        hideRedisDetails: true,
        sortQueues: true,
      },
    },
    queues: [
      new BullMQAdapter(getWorkflowRuntimeQueue(), {
        description:
          "Workflow runtime execution, wake-up, and settlement jobs.",
        readOnlyMode: true,
      }),
    ],
    serverAdapter,
  });

  boardApp.route(
    WORKFLOW_RUNTIME_BOARD_BASE_PATH,
    serverAdapter.registerPlugin(),
  );

  return boardApp;
}
