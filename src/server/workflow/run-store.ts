import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";
import { deserializeStoredWorkflowDocument } from "~/lib/workflow/document";
import {
  getErrorMessage,
  WorkflowAuthorizationError,
  WorkflowInfrastructureError,
  WorkflowRunNotFoundError,
} from "~/lib/workflow/errors";
import {
  isWorkflowRunLockingStatus,
  type WorkflowExecutionStatusResponse,
} from "~/lib/workflow/execution/types";
import { createRedisSubscriber, getRedisClient } from "~/server/redis";

type WorkflowRunRecord = {
  ownerUserId: string;
  projectId: string;
  run: WorkflowExecutionStatusResponse;
};

const WORKFLOW_RUN_TTL_SECONDS = 60 * 60 * 24;
const WORKFLOW_RUN_LOCK_TTL_MS = 30_000;
const WORKFLOW_RUN_LOCK_RETRY_MS = 40;
const WORKFLOW_RUN_LOCK_TIMEOUT_MS = 5_000;

function getWorkflowRunKey(runId: string) {
  return `workflow:run:${runId}`;
}

function getWorkflowRunChannel(runId: string) {
  return `workflow:run-events:${runId}`;
}

function getWorkflowProjectRunsKey(projectId: string) {
  return `workflow:project-runs:${projectId}`;
}

function getWorkflowRunLockKey(runId: string) {
  return `workflow:run-lock:${runId}`;
}

function cloneRunRecord(runRecord: WorkflowRunRecord) {
  return JSON.parse(JSON.stringify(runRecord)) as WorkflowRunRecord;
}

function cloneRun(run: WorkflowExecutionStatusResponse) {
  const clonedRun = cloneRunRecord({ ownerUserId: "", projectId: "", run }).run;
  return {
    ...clonedRun,
    document:
      deserializeStoredWorkflowDocument(clonedRun.document) ??
      clonedRun.document,
  };
}

async function getAuthorizedRunRecord(runId: string, userId: string) {
  const client = await getRedisClient();
  const storedRunRecord = await client.get(getWorkflowRunKey(runId));

  if (!storedRunRecord) {
    throw new WorkflowRunNotFoundError({
      message: `Workflow run ${runId} was not found.`,
    });
  }

  const runRecord = JSON.parse(storedRunRecord) as WorkflowRunRecord;
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

async function updateWorkflowRunRecord(run: WorkflowExecutionStatusResponse) {
  const client = await getRedisClient();
  const storedRunRecord = await client.get(getWorkflowRunKey(run.runId));

  if (!storedRunRecord) {
    throw new WorkflowRunNotFoundError({
      message: `Workflow run ${run.runId} was not found.`,
    });
  }

  const existingRunRecord = JSON.parse(storedRunRecord) as WorkflowRunRecord;
  if (!existingRunRecord) {
    throw new WorkflowRunNotFoundError({
      message: `Workflow run ${run.runId} was not found.`,
    });
  }

  const nextRunRecord = cloneRunRecord({
    ownerUserId: existingRunRecord.ownerUserId,
    projectId: existingRunRecord.projectId,
    run,
  });

  await client.set(
    getWorkflowRunKey(nextRunRecord.run.runId),
    JSON.stringify(nextRunRecord),
    {
      expiration: {
        type: "EX",
        value: WORKFLOW_RUN_TTL_SECONDS,
      },
    },
  );
  await client.publish(
    getWorkflowRunChannel(nextRunRecord.run.runId),
    JSON.stringify(nextRunRecord.run),
  );

  if (!isWorkflowRunLockingStatus(nextRunRecord.run.status)) {
    await client.sRem(
      getWorkflowProjectRunsKey(nextRunRecord.projectId),
      nextRunRecord.run.runId,
    );
  }

  return cloneRun(nextRunRecord.run);
}

async function acquireWorkflowRunLock(runId: string) {
  const client = await getRedisClient();
  const key = getWorkflowRunLockKey(runId);
  const token = randomUUID();
  const deadline = Date.now() + WORKFLOW_RUN_LOCK_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const result = await client.sendCommand([
      "SET",
      key,
      token,
      "PX",
      String(WORKFLOW_RUN_LOCK_TTL_MS),
      "NX",
    ]);
    if (String(result) === "OK") {
      return { key, token };
    }

    await new Promise((resolve) =>
      setTimeout(resolve, WORKFLOW_RUN_LOCK_RETRY_MS),
    );
  }

  throw new WorkflowInfrastructureError({
    message: `Timed out waiting for workflow run ${runId} to become writable.`,
  });
}

async function releaseWorkflowRunLock(lock: { key: string; token: string }) {
  const client = await getRedisClient();
  await client.sendCommand([
    "EVAL",
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    "1",
    lock.key,
    lock.token,
  ]);
}

export class WorkflowRunStore extends Context.Tag("WorkflowRunStore")<
  WorkflowRunStore,
  {
    readonly createRun: (params: {
      ownerUserId: string;
      projectId: string;
      run: WorkflowExecutionStatusResponse;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      WorkflowInfrastructureError
    >;
    readonly getProjectLockedNodeIds: (params: {
      projectId: string;
      userId: string;
    }) => Effect.Effect<string[], WorkflowInfrastructureError>;
    readonly getRun: (params: {
      runId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowInfrastructureError
      | WorkflowRunNotFoundError
    >;
    readonly updateRun: (
      run: WorkflowExecutionStatusResponse,
    ) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      WorkflowInfrastructureError | WorkflowRunNotFoundError
    >;
    readonly updateRunWith: <Result, UpdateError>(params: {
      runId: string;
      update: (currentRun: WorkflowExecutionStatusResponse) => Effect.Effect<
        {
          result: Result;
          run: WorkflowExecutionStatusResponse;
        },
        UpdateError
      >;
      userId: string;
    }) => Effect.Effect<
      {
        result: Result;
        run: WorkflowExecutionStatusResponse;
      },
      | UpdateError
      | WorkflowAuthorizationError
      | WorkflowInfrastructureError
      | WorkflowRunNotFoundError
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
      | WorkflowAuthorizationError
      | WorkflowInfrastructureError
      | WorkflowRunNotFoundError
    >;
  }
>() {
  static readonly functions = Effect.serviceFunctions(this);

  static readonly toRunStoreInfraError = (cause: unknown) => {
    if (cause instanceof WorkflowInfrastructureError) {
      return cause;
    }

    return new WorkflowInfrastructureError({
      message: getErrorMessage(cause),
      cause,
    });
  };

  static readonly toRunStoreReadError = (cause: unknown) => {
    if (
      cause instanceof WorkflowAuthorizationError ||
      cause instanceof WorkflowRunNotFoundError ||
      cause instanceof WorkflowInfrastructureError
    ) {
      return cause;
    }

    return new WorkflowInfrastructureError({
      message: getErrorMessage(cause),
      cause,
    });
  };

  static readonly toRunStoreUpdateError = (cause: unknown) => {
    if (
      cause instanceof WorkflowRunNotFoundError ||
      cause instanceof WorkflowInfrastructureError
    ) {
      return cause;
    }

    return new WorkflowInfrastructureError({
      message: getErrorMessage(cause),
      cause,
    });
  };

  static readonly Live = Layer.succeed(this, {
    createRun: ({ ownerUserId, projectId, run }) =>
      Effect.tryPromise({
        try: async () => {
          const client = await getRedisClient();
          const nextRunRecord = cloneRunRecord({
            ownerUserId,
            projectId,
            run,
          });

          await client.set(
            getWorkflowRunKey(nextRunRecord.run.runId),
            JSON.stringify(nextRunRecord),
            {
              expiration: {
                type: "EX",
                value: WORKFLOW_RUN_TTL_SECONDS,
              },
            },
          );
          await client.sAdd(
            getWorkflowProjectRunsKey(nextRunRecord.projectId),
            nextRunRecord.run.runId,
          );

          return cloneRun(nextRunRecord.run);
        },
        catch: WorkflowRunStore.toRunStoreInfraError,
      }),
    getProjectLockedNodeIds: ({ projectId, userId }) =>
      Effect.tryPromise({
        try: async () => {
          const client = await getRedisClient();
          const runIds = await client.sMembers(
            getWorkflowProjectRunsKey(projectId),
          );
          const lockedNodeIds = new Set<string>();
          const staleRunIds: string[] = [];

          for (const runId of runIds) {
            const storedRunRecord = await client.get(getWorkflowRunKey(runId));
            if (!storedRunRecord) {
              staleRunIds.push(runId);
              continue;
            }

            try {
              const runRecord = JSON.parse(
                storedRunRecord,
              ) as WorkflowRunRecord;
              if (runRecord.ownerUserId !== userId) {
                continue;
              }

              if (!isWorkflowRunLockingStatus(runRecord.run.status)) {
                staleRunIds.push(runId);
                continue;
              }

              for (const nodeId of runRecord.run.targetNodeIds) {
                lockedNodeIds.add(nodeId);
              }
            } catch {
              staleRunIds.push(runId);
            }
          }

          if (staleRunIds.length) {
            await client.sRem(
              getWorkflowProjectRunsKey(projectId),
              staleRunIds,
            );
          }

          return [...lockedNodeIds];
        },
        catch: WorkflowRunStore.toRunStoreInfraError,
      }),
    getRun: ({ runId, userId }) =>
      Effect.tryPromise({
        try: async () => {
          const runRecord = await getAuthorizedRunRecord(runId, userId);
          return cloneRun(runRecord.run);
        },
        catch: WorkflowRunStore.toRunStoreReadError,
      }),
    updateRun: (run) =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => acquireWorkflowRunLock(run.runId),
          catch: WorkflowRunStore.toRunStoreInfraError,
        }),
        () =>
          Effect.tryPromise({
            try: () => updateWorkflowRunRecord(run),
            catch: WorkflowRunStore.toRunStoreUpdateError,
          }),
        (lock) =>
          Effect.tryPromise({
            try: () => releaseWorkflowRunLock(lock),
            catch: WorkflowRunStore.toRunStoreInfraError,
          }).pipe(Effect.catchAll(() => Effect.void)),
      ),
    updateRunWith: ({ runId, update, userId }) =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => acquireWorkflowRunLock(runId),
          catch: WorkflowRunStore.toRunStoreInfraError,
        }),
        () =>
          Effect.gen(function* () {
            const runRecord = yield* Effect.tryPromise({
              try: () => getAuthorizedRunRecord(runId, userId),
              catch: WorkflowRunStore.toRunStoreReadError,
            });
            const next = yield* update(cloneRun(runRecord.run));
            const run = yield* Effect.tryPromise({
              try: () => updateWorkflowRunRecord(next.run),
              catch: WorkflowRunStore.toRunStoreUpdateError,
            });

            return {
              result: next.result,
              run,
            };
          }),
        (lock) =>
          Effect.tryPromise({
            try: () => releaseWorkflowRunLock(lock),
            catch: WorkflowRunStore.toRunStoreInfraError,
          }).pipe(Effect.catchAll(() => Effect.void)),
      ),
    subscribe: (runId, userId, listener) =>
      Effect.tryPromise({
        try: async () => {
          const subscriber = await createRedisSubscriber();
          const bufferedRuns: WorkflowExecutionStatusResponse[] = [];
          let isReady = false;
          const channel = getWorkflowRunChannel(runId);

          const handleRunMessage = (message: string) => {
            try {
              const run = cloneRun(
                JSON.parse(message) as WorkflowExecutionStatusResponse,
              );

              if (!isReady) {
                bufferedRuns.push(run);
                return;
              }

              listener(run);
            } catch (error) {
              console.error("Failed to parse workflow run event", error);
            }
          };

          await subscriber.subscribe(channel, handleRunMessage);

          try {
            const run = cloneRun(
              (await getAuthorizedRunRecord(runId, userId)).run,
            );
            const initialRun = cloneRun(bufferedRuns.at(-1) ?? run);

            isReady = true;

            return {
              initialRun,
              unsubscribe: () => {
                void subscriber
                  .unsubscribe(channel, handleRunMessage)
                  .catch((error) => {
                    console.error(
                      "Failed to unsubscribe from workflow run",
                      error,
                    );
                  })
                  .finally(() => {
                    void subscriber.close().catch((error) => {
                      console.error(
                        "Failed to close workflow run subscriber",
                        error,
                      );
                    });
                  });
              },
            };
          } catch (error) {
            await subscriber
              .unsubscribe(channel, handleRunMessage)
              .catch(() => {
                return undefined;
              });
            await subscriber.close().catch(() => {
              return undefined;
            });
            throw error;
          }
        },
        catch: WorkflowRunStore.toRunStoreReadError,
      }),
  });
}
