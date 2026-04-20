import { Effect } from "effect";

import { ServerRuntime } from "~/effect/server/runtime";
import {
  getErrorMessage,
  WorkflowAuthorizationError,
  WorkflowRunNotFoundError,
} from "~/lib/workflow/errors";
import type { WorkflowExecutionStatusResponse } from "~/lib/workflow/execution/types";
import { auth } from "~/server/better-auth";
import { WorkflowRunStore } from "~/server/workflow/run-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SSE_HEADERS = {
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream",
  "X-Accel-Buffering": "no",
} as const;

function isTerminalStatus(status: WorkflowExecutionStatusResponse["status"]) {
  return status === "success" || status === "error";
}

function formatSseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const encoder = new TextEncoder();

  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return Response.json(
        { error: "Unauthorized" },
        {
          status: 401,
        },
      );
    }

    const { runId } = await context.params;
    const userId = session.user.id;

    let cancel = () => {};

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let isClosed = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let unsubscribe = () => {};

        const close = () => {
          if (isClosed) {
            return;
          }

          isClosed = true;
          unsubscribe();
          if (heartbeat) {
            clearInterval(heartbeat);
          }
          controller.close();
        };

        const push = (event: string, data: unknown) => {
          if (isClosed) {
            return;
          }

          controller.enqueue(encoder.encode(formatSseEvent(event, data)));
        };

        cancel = close;
        request.signal.addEventListener("abort", close, { once: true });

        push("ready", { runId });

        const subscription = await ServerRuntime.runPromise(
          Effect.gen(function* () {
            const workflowRunStore = yield* WorkflowRunStore;
            return yield* workflowRunStore.subscribe(runId, userId, (run) => {
              push("status", run);
              if (isTerminalStatus(run.status)) {
                close();
              }
            });
          }),
        );

        unsubscribe = subscription.unsubscribe;

        if (isClosed) {
          unsubscribe();
          return;
        }

        push("status", subscription.initialRun);

        if (isTerminalStatus(subscription.initialRun.status)) {
          close();
          return;
        }

        heartbeat = setInterval(() => {
          if (!isClosed) {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          }
        }, 15_000);
      },
      cancel() {
        cancel();
      },
    });

    return new Response(stream, {
      headers: SSE_HEADERS,
    });
  } catch (error) {
    const status =
      error instanceof WorkflowAuthorizationError
        ? 403
        : error instanceof WorkflowRunNotFoundError
          ? 404
          : 500;

    return Response.json(
      { error: getErrorMessage(error) },
      {
        status,
      },
    );
  }
}
