import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";
import { deserializeStoredWorkflowDocument } from "~/lib/workflow/document";
import {
  getErrorMessage,
  WorkflowAuthorizationError,
  WorkflowExecutionNotFoundError,
  WorkflowInfrastructureError,
} from "~/lib/workflow/errors";
import {
  isWorkflowExecutionLockingStatus,
  type WorkflowExecutionStatusResponse,
} from "~/lib/workflow/execution/types";
import { createRedisSubscriber, getRedisClient } from "~/server/redis";

type WorkflowExecutionRecord = {
  ownerUserId: string;
  projectId: string;
  run: WorkflowExecutionStatusResponse;
};

const WORKFLOW_EXECUTION_TTL_SECONDS = 60 * 60 * 24;
const WORKFLOW_EXECUTION_LOCK_TTL_MS = 30_000;
const WORKFLOW_EXECUTION_LOCK_RETRY_MS = 40;
const WORKFLOW_EXECUTION_LOCK_TIMEOUT_MS = 5_000;

function getWorkflowExecutionKey(executionId: string) {
  return `workflow:execution:${executionId}`;
}

function getWorkflowExecutionChannel(executionId: string) {
  return `workflow:execution-events:${executionId}`;
}

function getWorkflowProjectExecutionsKey(projectId: string) {
  return `workflow:project-executions:${projectId}`;
}

function getWorkflowExecutionLockKey(executionId: string) {
  return `workflow:execution-lock:${executionId}`;
}

function cloneExecutionRecord(executionRecord: WorkflowExecutionRecord) {
  return JSON.parse(JSON.stringify(executionRecord)) as WorkflowExecutionRecord;
}

function cloneExecution(run: WorkflowExecutionStatusResponse) {
  const clonedRun = cloneExecutionRecord({
    ownerUserId: "",
    projectId: "",
    run,
  }).run;
  return {
    ...clonedRun,
    document:
      deserializeStoredWorkflowDocument(clonedRun.document) ??
      clonedRun.document,
  };
}

async function getAuthorizedExecutionRecord(
  executionId: string,
  userId: string,
) {
  const client = await getRedisClient();
  const storedExecutionRecord = await client.get(
    getWorkflowExecutionKey(executionId),
  );

  if (!storedExecutionRecord) {
    throw new WorkflowExecutionNotFoundError({
      message: `Workflow execution ${executionId} was not found.`,
    });
  }

  const executionRecord = JSON.parse(
    storedExecutionRecord,
  ) as WorkflowExecutionRecord;
  if (!executionRecord) {
    throw new WorkflowExecutionNotFoundError({
      message: `Workflow execution ${executionId} was not found.`,
    });
  }

  if (executionRecord.ownerUserId !== userId) {
    throw new WorkflowAuthorizationError({
      message: `You are not authorized to access workflow execution ${executionId}.`,
    });
  }

  return executionRecord;
}

async function updateWorkflowExecutionRecord(
  run: WorkflowExecutionStatusResponse,
) {
  const client = await getRedisClient();
  const storedExecutionRecord = await client.get(
    getWorkflowExecutionKey(run.executionId),
  );

  if (!storedExecutionRecord) {
    throw new WorkflowExecutionNotFoundError({
      message: `Workflow execution ${run.executionId} was not found.`,
    });
  }

  const existingExecutionRecord = JSON.parse(
    storedExecutionRecord,
  ) as WorkflowExecutionRecord;
  if (!existingExecutionRecord) {
    throw new WorkflowExecutionNotFoundError({
      message: `Workflow execution ${run.executionId} was not found.`,
    });
  }

  const nextExecutionRecord = cloneExecutionRecord({
    ownerUserId: existingExecutionRecord.ownerUserId,
    projectId: existingExecutionRecord.projectId,
    run,
  });

  await client.set(
    getWorkflowExecutionKey(nextExecutionRecord.run.executionId),
    JSON.stringify(nextExecutionRecord),
    {
      expiration: {
        type: "EX",
        value: WORKFLOW_EXECUTION_TTL_SECONDS,
      },
    },
  );
  await client.publish(
    getWorkflowExecutionChannel(nextExecutionRecord.run.executionId),
    JSON.stringify(nextExecutionRecord.run),
  );

  if (!isWorkflowExecutionLockingStatus(nextExecutionRecord.run.status)) {
    await client.sRem(
      getWorkflowProjectExecutionsKey(nextExecutionRecord.projectId),
      nextExecutionRecord.run.executionId,
    );
  }

  return cloneExecution(nextExecutionRecord.run);
}

async function acquireWorkflowExecutionLock(executionId: string) {
  const client = await getRedisClient();
  const key = getWorkflowExecutionLockKey(executionId);
  const token = randomUUID();
  const deadline = Date.now() + WORKFLOW_EXECUTION_LOCK_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const result = await client.sendCommand([
      "SET",
      key,
      token,
      "PX",
      String(WORKFLOW_EXECUTION_LOCK_TTL_MS),
      "NX",
    ]);
    if (String(result) === "OK") {
      return { key, token };
    }

    await new Promise((resolve) =>
      setTimeout(resolve, WORKFLOW_EXECUTION_LOCK_RETRY_MS),
    );
  }

  throw new WorkflowInfrastructureError({
    message: `Timed out waiting for workflow execution ${executionId} to become writable.`,
  });
}

async function releaseWorkflowExecutionLock(lock: {
  key: string;
  token: string;
}) {
  const client = await getRedisClient();
  await client.sendCommand([
    "EVAL",
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    "1",
    lock.key,
    lock.token,
  ]);
}

export class WorkflowExecutionStore extends Context.Tag(
  "WorkflowExecutionStore",
)<
  WorkflowExecutionStore,
  {
    readonly createExecution: (params: {
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
    readonly getExecution: (params: {
      executionId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowInfrastructureError
      | WorkflowExecutionNotFoundError
    >;
    readonly updateExecution: (
      run: WorkflowExecutionStatusResponse,
    ) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      WorkflowInfrastructureError | WorkflowExecutionNotFoundError
    >;
    readonly updateExecutionWith: <Result, UpdateError>(params: {
      executionId: string;
      update: (
        currentExecution: WorkflowExecutionStatusResponse,
      ) => Effect.Effect<
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
      | WorkflowExecutionNotFoundError
    >;
    readonly subscribe: (
      executionId: string,
      userId: string,
      listener: (run: WorkflowExecutionStatusResponse) => void,
    ) => Effect.Effect<
      {
        initialExecution: WorkflowExecutionStatusResponse;
        unsubscribe: () => void;
      },
      | WorkflowAuthorizationError
      | WorkflowInfrastructureError
      | WorkflowExecutionNotFoundError
    >;
  }
>() {
  static readonly toExecutionStoreInfraError = (cause: unknown) => {
    if (cause instanceof WorkflowInfrastructureError) {
      return cause;
    }

    return new WorkflowInfrastructureError({
      message: getErrorMessage(cause),
      cause,
    });
  };

  static readonly toExecutionStoreReadError = (cause: unknown) => {
    if (
      cause instanceof WorkflowAuthorizationError ||
      cause instanceof WorkflowExecutionNotFoundError ||
      cause instanceof WorkflowInfrastructureError
    ) {
      return cause;
    }

    return new WorkflowInfrastructureError({
      message: getErrorMessage(cause),
      cause,
    });
  };

  static readonly toExecutionStoreUpdateError = (cause: unknown) => {
    if (
      cause instanceof WorkflowExecutionNotFoundError ||
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
    createExecution: ({ ownerUserId, projectId, run }) =>
      Effect.tryPromise({
        try: async () => {
          const client = await getRedisClient();
          const nextExecutionRecord = cloneExecutionRecord({
            ownerUserId,
            projectId,
            run,
          });

          await client.set(
            getWorkflowExecutionKey(nextExecutionRecord.run.executionId),
            JSON.stringify(nextExecutionRecord),
            {
              expiration: {
                type: "EX",
                value: WORKFLOW_EXECUTION_TTL_SECONDS,
              },
            },
          );
          await client.sAdd(
            getWorkflowProjectExecutionsKey(nextExecutionRecord.projectId),
            nextExecutionRecord.run.executionId,
          );

          return cloneExecution(nextExecutionRecord.run);
        },
        catch: WorkflowExecutionStore.toExecutionStoreInfraError,
      }),
    getProjectLockedNodeIds: ({ projectId, userId }) =>
      Effect.tryPromise({
        try: async () => {
          const client = await getRedisClient();
          const executionIds = await client.sMembers(
            getWorkflowProjectExecutionsKey(projectId),
          );
          const lockedNodeIds = new Set<string>();
          const staleExecutionIds: string[] = [];

          for (const executionId of executionIds) {
            const storedExecutionRecord = await client.get(
              getWorkflowExecutionKey(executionId),
            );
            if (!storedExecutionRecord) {
              staleExecutionIds.push(executionId);
              continue;
            }

            try {
              const executionRecord = JSON.parse(
                storedExecutionRecord,
              ) as WorkflowExecutionRecord;
              if (executionRecord.ownerUserId !== userId) {
                continue;
              }

              if (
                !isWorkflowExecutionLockingStatus(executionRecord.run.status)
              ) {
                staleExecutionIds.push(executionId);
                continue;
              }

              for (const nodeId of executionRecord.run.targetNodeIds) {
                lockedNodeIds.add(nodeId);
              }
            } catch {
              staleExecutionIds.push(executionId);
            }
          }

          if (staleExecutionIds.length) {
            await client.sRem(
              getWorkflowProjectExecutionsKey(projectId),
              staleExecutionIds,
            );
          }

          return [...lockedNodeIds];
        },
        catch: WorkflowExecutionStore.toExecutionStoreInfraError,
      }),
    getExecution: ({ executionId, userId }) =>
      Effect.tryPromise({
        try: async () => {
          const executionRecord = await getAuthorizedExecutionRecord(
            executionId,
            userId,
          );
          return cloneExecution(executionRecord.run);
        },
        catch: WorkflowExecutionStore.toExecutionStoreReadError,
      }),
    updateExecution: (run) =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => acquireWorkflowExecutionLock(run.executionId),
          catch: WorkflowExecutionStore.toExecutionStoreInfraError,
        }),
        () =>
          Effect.tryPromise({
            try: () => updateWorkflowExecutionRecord(run),
            catch: WorkflowExecutionStore.toExecutionStoreUpdateError,
          }),
        (lock) =>
          Effect.tryPromise({
            try: () => releaseWorkflowExecutionLock(lock),
            catch: WorkflowExecutionStore.toExecutionStoreInfraError,
          }).pipe(Effect.catchAll(() => Effect.void)),
      ),
    updateExecutionWith: ({ executionId, update, userId }) =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => acquireWorkflowExecutionLock(executionId),
          catch: WorkflowExecutionStore.toExecutionStoreInfraError,
        }),
        () =>
          Effect.gen(function* () {
            const executionRecord = yield* Effect.tryPromise({
              try: () => getAuthorizedExecutionRecord(executionId, userId),
              catch: WorkflowExecutionStore.toExecutionStoreReadError,
            });
            const next = yield* update(cloneExecution(executionRecord.run));
            const run = yield* Effect.tryPromise({
              try: () => updateWorkflowExecutionRecord(next.run),
              catch: WorkflowExecutionStore.toExecutionStoreUpdateError,
            });

            return {
              result: next.result,
              run,
            };
          }),
        (lock) =>
          Effect.tryPromise({
            try: () => releaseWorkflowExecutionLock(lock),
            catch: WorkflowExecutionStore.toExecutionStoreInfraError,
          }).pipe(Effect.catchAll(() => Effect.void)),
      ),
    subscribe: (executionId, userId, listener) =>
      Effect.tryPromise({
        try: async () => {
          const subscriber = await createRedisSubscriber();
          const bufferedExecutions: WorkflowExecutionStatusResponse[] = [];
          let isReady = false;
          const channel = getWorkflowExecutionChannel(executionId);

          const handleExecutionMessage = (message: string) => {
            try {
              const run = cloneExecution(
                JSON.parse(message) as WorkflowExecutionStatusResponse,
              );

              if (!isReady) {
                bufferedExecutions.push(run);
                return;
              }

              listener(run);
            } catch (error) {
              console.error("Failed to parse workflow execution event", error);
            }
          };

          await subscriber.subscribe(channel, handleExecutionMessage);

          try {
            const run = cloneExecution(
              (await getAuthorizedExecutionRecord(executionId, userId)).run,
            );
            const initialExecution = cloneExecution(
              bufferedExecutions.at(-1) ?? run,
            );

            isReady = true;

            return {
              initialExecution,
              unsubscribe: () => {
                void subscriber
                  .unsubscribe(channel, handleExecutionMessage)
                  .catch((error) => {
                    console.error(
                      "Failed to unsubscribe from workflow execution",
                      error,
                    );
                  })
                  .finally(() => {
                    void subscriber.close().catch((error) => {
                      console.error(
                        "Failed to close workflow execution subscriber",
                        error,
                      );
                    });
                  });
              },
            };
          } catch (error) {
            await subscriber
              .unsubscribe(channel, handleExecutionMessage)
              .catch(() => {
                return undefined;
              });
            await subscriber.close().catch(() => {
              return undefined;
            });
            throw error;
          }
        },
        catch: WorkflowExecutionStore.toExecutionStoreReadError,
      }),
  });
}
