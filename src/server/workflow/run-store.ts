import "server-only";

import { Context, Effect, Layer } from "effect";

import {
  WorkflowAuthorizationError,
  WorkflowRunNotFoundError,
} from "~/lib/workflow/errors";
import type { WorkflowExecutionStatusResponse } from "~/lib/workflow/execution/types";

type WorkflowRunRecord = {
  ownerUserId: string;
  run: WorkflowExecutionStatusResponse;
};

const runs = new Map<string, WorkflowRunRecord>();
const listenersByRunId = new Map<
  string,
  Set<(run: WorkflowExecutionStatusResponse) => void>
>();

function cloneRunRecord(runRecord: WorkflowRunRecord) {
  return JSON.parse(JSON.stringify(runRecord)) as WorkflowRunRecord;
}

function cloneRun(run: WorkflowExecutionStatusResponse) {
  return cloneRunRecord({ ownerUserId: "", run }).run;
}

function getAuthorizedRunRecord(runId: string, userId: string) {
  const runRecord = runs.get(runId);
  if (!runRecord) {
    throw new WorkflowRunNotFoundError({
      message: `Workflow run ${runId} was not found.`,
    });
  }

  if (runRecord.ownerUserId !== userId) {
    throw new WorkflowAuthorizationError({
      message: `You are not authorized to access workflow run ${runId}.`,
    });
  }

  return runRecord;
}

export class WorkflowRunStore extends Context.Tag("WorkflowRunStore")<
  WorkflowRunStore,
  {
    readonly createRun: (params: {
      ownerUserId: string;
      run: WorkflowExecutionStatusResponse;
    }) => Effect.Effect<WorkflowExecutionStatusResponse>;
    readonly getRun: (params: {
      runId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      WorkflowAuthorizationError | WorkflowRunNotFoundError
    >;
    readonly updateRun: (
      run: WorkflowExecutionStatusResponse,
    ) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      WorkflowRunNotFoundError
    >;
    readonly subscribe: (
      runId: string,
      userId: string,
      listener: (run: WorkflowExecutionStatusResponse) => void,
    ) => Effect.Effect<
      {
        initialRun: WorkflowExecutionStatusResponse;
        unsubscribe: () => void;
      },
      WorkflowAuthorizationError | WorkflowRunNotFoundError
    >;
  }
>() {
  static readonly functions = Effect.serviceFunctions(this);

  static readonly Live = Layer.succeed(this, {
    createRun: ({ ownerUserId, run }) =>
      Effect.sync(() => {
        const nextRunRecord = cloneRunRecord({
          ownerUserId,
          run,
        });
        runs.set(nextRunRecord.run.runId, nextRunRecord);
        return cloneRun(nextRunRecord.run);
      }),
    getRun: ({ runId, userId }) =>
      Effect.sync(() => {
        const runRecord = getAuthorizedRunRecord(runId, userId);
        return cloneRun(runRecord.run);
      }),
    updateRun: (run) =>
      Effect.sync(() => {
        const existingRunRecord = runs.get(run.runId);
        if (!existingRunRecord) {
          throw new WorkflowRunNotFoundError({
            message: `Workflow run ${run.runId} was not found.`,
          });
        }

        const nextRunRecord = cloneRunRecord({
          ownerUserId: existingRunRecord.ownerUserId,
          run,
        });
        runs.set(nextRunRecord.run.runId, nextRunRecord);
        for (const listener of listenersByRunId.get(nextRunRecord.run.runId) ??
          []) {
          listener(cloneRun(nextRunRecord.run));
        }
        return cloneRun(nextRunRecord.run);
      }),
    subscribe: (runId, userId, listener) =>
      Effect.gen(function* () {
        const run = yield* Effect.sync(() =>
          cloneRun(getAuthorizedRunRecord(runId, userId).run),
        );

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
