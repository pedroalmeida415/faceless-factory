import { Effect, Layer, ManagedRuntime } from "effect";
import {
  EventPublisherService,
  RuntimeCommands,
  RuntimeIdGenerator,
} from "~/features/runtime/server/commands";
import { RuntimePostCommitWork } from "~/features/runtime/server/post-commit-work";
import {
  RuntimeRepositoryLive,
  RuntimeRepositoryTest,
} from "~/features/runtime/server/repository";
import { createWorkflowEventPublisher } from "~/features/runtime/server/task-status-event-stream";
import { getRedisClient } from "~/server/redis";
import { CreditsService } from "~/server/services/credits";
import {
  DatabaseServiceLive,
  DatabaseServiceTest,
} from "~/server/services/database";
import { ProjectStoreService } from "~/server/services/project-store";
import {
  createWorkflowQueueAdapter,
  getWorkflowQueue,
  QueueService,
} from "~/server/services/queue";
import { StorageService } from "~/server/services/storage";
import { TelemetryService } from "~/server/services/telemetry";
import { VertexAiService } from "~/server/services/vertex";

const RuntimeDependenciesLive = Layer.mergeAll(
  RuntimeRepositoryLive.pipe(Layer.provide(DatabaseServiceLive)),
  Layer.effect(
    QueueService,
    Effect.sync(() => createWorkflowQueueAdapter(getWorkflowQueue())),
  ),
  Layer.effect(
    EventPublisherService,
    Effect.tryPromise({
      try: async () => createWorkflowEventPublisher(await getRedisClient()),
      catch: (cause) => cause,
    }),
  ),
  RuntimeIdGenerator.Live,
);

const RuntimeDependenciesTest = Layer.mergeAll(
  RuntimeRepositoryTest.pipe(Layer.provide(DatabaseServiceTest)),
  QueueService.Test,
  EventPublisherService.Test,
  RuntimeIdGenerator.Test,
);

const RuntimePostCommitWorkLive = RuntimePostCommitWork.Live.pipe(
  Layer.provide(Layer.mergeAll(RuntimeDependenciesLive, TelemetryService.Live)),
);

const RuntimePostCommitWorkTest = RuntimePostCommitWork.Test.pipe(
  Layer.provide(Layer.mergeAll(RuntimeDependenciesTest, TelemetryService.Test)),
);

const RuntimeCommandsTest = RuntimeCommands.Test.pipe(
  Layer.provide(
    Layer.mergeAll(RuntimeDependenciesTest, RuntimePostCommitWorkTest),
  ),
);

const StorageServiceLive = StorageService.Live.pipe(
  Layer.provide(DatabaseServiceLive),
);
const CreditsServiceLive = CreditsService.Live.pipe(
  Layer.provide(DatabaseServiceLive),
);

export const ServerRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    CreditsServiceLive,
    ProjectStoreService.Live,
    StorageServiceLive,
    VertexAiService.Live.pipe(Layer.provide(StorageServiceLive)),
    DatabaseServiceLive,
    RuntimeDependenciesLive,
    TelemetryService.Live,
    RuntimePostCommitWorkLive,
    RuntimeCommands.Live.pipe(
      Layer.provide(
        Layer.mergeAll(RuntimeDependenciesLive, RuntimePostCommitWorkLive),
      ),
    ),
  ),
);
export const ServerTestRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    DatabaseServiceTest,
    RuntimeDependenciesTest,
    TelemetryService.Test,
    RuntimePostCommitWorkTest,
    RuntimeCommandsTest,
  ),
);
