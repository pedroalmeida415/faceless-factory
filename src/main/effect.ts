import { Layer, ManagedRuntime } from "effect";
import { BullMqJobQueueLive } from "~/core/infra/bullmq-job-queue";
import { DatabaseLive } from "~/core/infra/database-drizzle";
import { OpenTelemetryLive } from "~/core/infra/opentelemetry";
import { RedisPubSubLive } from "~/core/infra/redis-pubsub";
import { S3ObjectStorageLive } from "~/core/infra/s3-object-storage";
import { Features } from "~/features";

const CoreServicesLive = Layer.mergeAll(
  DatabaseLive,
  BullMqJobQueueLive,
  S3ObjectStorageLive,
  RedisPubSubLive,
  OpenTelemetryLive,
);

const ServerLayerLive = Features.pipe(Layer.provide(CoreServicesLive));

export const ServerRuntimeLive = ManagedRuntime.make(ServerLayerLive);
