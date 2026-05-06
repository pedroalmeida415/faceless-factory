import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { getWorkflowQueue } from "~/server/services/queue";

export const RUNTIME_BOARD_BASE_PATH = "/admin/queues";

const globalForRuntimeBoard = globalThis as typeof globalThis & {
  __runtimeBoardApp?: Hono;
};

export function getRuntimeBoardApp() {
  globalForRuntimeBoard.__runtimeBoardApp ??= createRuntimeBoardApp();

  return globalForRuntimeBoard.__runtimeBoardApp;
}

function createRuntimeBoardApp() {
  const boardApp = new Hono();
  const serverAdapter = new HonoAdapter(serveStatic).setBasePath(
    RUNTIME_BOARD_BASE_PATH,
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
      new BullMQAdapter(getWorkflowQueue(), {
        description:
          "Workflow runtime execution, wake-up, and settlement jobs.",
        readOnlyMode: true,
      }),
    ],
    serverAdapter,
  });

  boardApp.route(RUNTIME_BOARD_BASE_PATH, serverAdapter.registerPlugin());

  return boardApp;
}
