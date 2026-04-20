import "server-only";

import { Context, Effect, Layer } from "effect";

import { WorkflowRunNotFoundError } from "~/lib/workflow/errors";
import type { WorkflowExecutionStatusResponse } from "~/lib/workflow/execution/types";

const runs = new Map<string, WorkflowExecutionStatusResponse>();
const listenersByRunId = new Map<
  string,
  Set<(run: WorkflowExecutionStatusResponse) => void>
>();

function cloneRun(run: WorkflowExecutionStatusResponse) {
  return JSON.parse(JSON.stringify(run)) as WorkflowExecutionStatusResponse;
}

export class WorkflowRunStore extends Context.Tag("WorkflowRunStore")<
  WorkflowRunStore,
  {
    readonly createRun: (
      run: WorkflowExecutionStatusResponse,
    ) => Effect.Effect<WorkflowExecutionStatusResponse>;
    readonly updateRun: (
      run: WorkflowExecutionStatusResponse,
    ) => Effect.Effect<WorkflowExecutionStatusResponse>;
    readonly subscribe: (
      runId: string,
      listener: (run: WorkflowExecutionStatusResponse) => void,
    ) => Effect.Effect<
      {
        initialRun: WorkflowExecutionStatusResponse;
        unsubscribe: () => void;
      },
      WorkflowRunNotFoundError
    >;
  }
>() {
  static readonly functions = Effect.serviceFunctions(this);

  static readonly Live = Layer.succeed(this, {
    createRun: (run) =>
      Effect.sync(() => {
        const nextRun = cloneRun(run);
        runs.set(nextRun.runId, nextRun);
        return cloneRun(nextRun);
      }),
    updateRun: (run) =>
      Effect.sync(() => {
        const nextRun = cloneRun(run);
        runs.set(nextRun.runId, nextRun);
        for (const listener of listenersByRunId.get(nextRun.runId) ?? []) {
          listener(cloneRun(nextRun));
        }
        return cloneRun(nextRun);
      }),
    subscribe: (runId, listener) =>
      Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          const currentRun = runs.get(runId);
          if (!currentRun) {
            return yield* Effect.fail(
              new WorkflowRunNotFoundError({
                message: `Workflow run ${runId} was not found.`,
              }),
            );
          }

          return currentRun;
        });

        const nextListeners = listenersByRunId.get(runId) ?? new Set();
        nextListeners.add(listener);
        listenersByRunId.set(runId, nextListeners);

        return {
          initialRun: cloneRun(run),
          unsubscribe: () => {
            const currentListeners = listenersByRunId.get(runId);
            if (!currentListeners) {
              return;
            }

            currentListeners.delete(listener);
            if (!currentListeners.size) {
              listenersByRunId.delete(runId);
            }
          },
        };
      }),
  });
}
