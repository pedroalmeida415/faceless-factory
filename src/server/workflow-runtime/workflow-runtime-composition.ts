import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Queue } from "bullmq";
import type { DrizzleConfig } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";

import { env } from "~/env";
import * as schema from "~/server/db/schema";
import { getRedisClient } from "~/server/redis";
import { createWorkflowEventPublisher } from "~/server/workflow-runtime/task-status-event-stream";
import {
  WorkflowRuntimeCommands,
  WorkflowRuntimeEventPublisher,
  WorkflowRuntimeIdGenerator,
  WorkflowRuntimeQueue,
  WorkflowRuntimeRepository,
} from "~/server/workflow-runtime/workflow-runtime-commands";
import { WorkflowRuntimePostCommitWork } from "~/server/workflow-runtime/workflow-runtime-post-commit-work";
import { createWorkflowRuntimeQueueAdapter } from "~/server/workflow-runtime/workflow-runtime-queue";
import {
  createWorkflowRuntimeRepository,
  type WorkflowRuntimeRepositoryFailure,
} from "~/server/workflow-runtime/workflow-runtime-repository";
import { WorkflowRuntimeTelemetry } from "~/server/workflow-runtime/workflow-runtime-telemetry";
import {
  WORKFLOW_RUNTIME_JOB_HISTORY_AGE_SECONDS,
  WORKFLOW_RUNTIME_QUEUE_NAME,
  workflowRuntimeQueueConnection,
} from "~/server/workflow-runtime/workflow-runtime-worker";

const globalForWorkflowRuntime = globalThis as typeof globalThis & {
  __workflowRuntimeManagedRuntime?: ManagedRuntime.ManagedRuntime<
    | WorkflowRuntimeCommands
    | WorkflowRuntimePostCommitWork
    | WorkflowRuntimeTelemetry,
    unknown
  >;
  __workflowRuntimeQueue?: Queue;
};

export function getWorkflowRuntimeQueue() {
  globalForWorkflowRuntime.__workflowRuntimeQueue ??= new Queue(
    WORKFLOW_RUNTIME_QUEUE_NAME,
    {
      connection: workflowRuntimeQueueConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          delay: 2_000,
          type: "exponential",
        },
        removeOnComplete: {
          age: WORKFLOW_RUNTIME_JOB_HISTORY_AGE_SECONDS,
          count: 100,
        },
        removeOnFail: {
          age: WORKFLOW_RUNTIME_JOB_HISTORY_AGE_SECONDS,
          count: 500,
        },
      },
    },
  );

  return globalForWorkflowRuntime.__workflowRuntimeQueue;
}

export async function createWorkflowRuntimeComposition() {
  const repository = createWorkflowRuntimeRepository({
    sqlLayer: createWorkflowRuntimeSqlLayer(),
  });
  const queue = createWorkflowRuntimeQueueAdapter(getWorkflowRuntimeQueue());
  const eventPublisher = createWorkflowEventPublisher(await getRedisClient());

  return {
    eventPublisher,
    queue,
    repository,
  };
}

export function getWorkflowRuntimeManagedRuntime() {
  globalForWorkflowRuntime.__workflowRuntimeManagedRuntime ??=
    ManagedRuntime.make(createWorkflowRuntimeLiveLayer());

  return globalForWorkflowRuntime.__workflowRuntimeManagedRuntime;
}

export function createWorkflowRuntimeLiveLayer() {
  const SqlLive = createWorkflowRuntimeSqlLayer();
  const RepositoryLive = Layer.succeed(
    WorkflowRuntimeRepository,
    createWorkflowRuntimeRepository({ sqlLayer: SqlLive }),
  );
  const QueueLive = Layer.succeed(
    WorkflowRuntimeQueue,
    createWorkflowRuntimeQueueAdapter(getWorkflowRuntimeQueue()),
  );
  const EventPublisherLive = Layer.effect(
    WorkflowRuntimeEventPublisher,
    Effect.tryPromise({
      try: async () => createWorkflowEventPublisher(await getRedisClient()),
      catch: (cause) => cause,
    }),
  );

  const DependenciesLive = Layer.mergeAll(
    RepositoryLive,
    QueueLive,
    EventPublisherLive,
    WorkflowRuntimeIdGenerator.Live,
  );
  const TelemetryLive = WorkflowRuntimeTelemetry.Live;
  const PostCommitWorkLive = WorkflowRuntimePostCommitWork.Live.pipe(
    Layer.provide(Layer.mergeAll(DependenciesLive, TelemetryLive)),
  );

  return Layer.mergeAll(
    TelemetryLive,
    PostCommitWorkLive,
    WorkflowRuntimeCommands.Live.pipe(
      Layer.provide(Layer.mergeAll(DependenciesLive, PostCommitWorkLive)),
    ),
  );
}

export function createWorkflowRuntimeSqlLayer() {
  const PgClientLive = PgClient.layer({
    url: Redacted.make(env.DATABASE_URL),
  });
  return Layer.mergeAll(
    PgClientLive,
    PgDrizzle.layerWithConfig({ schema } as unknown as DrizzleConfig).pipe(
      Layer.provide(PgClientLive),
    ),
  ).pipe(
    Layer.mapError(
      (cause): WorkflowRuntimeRepositoryFailure => ({
        _tag: "WorkflowRuntimeRepositoryFailure",
        cause,
        operation: "createWorkflowRuntimeSqlLayer",
      }),
    ),
  );
}
