import { Layer, ManagedRuntime } from "effect";
import { BullMqJobQueueLive } from "~/core/infra/bullmq-job-queue";
import { DatabaseLive } from "~/core/infra/database-drizzle";
import { OpenTelemetryLive } from "~/core/infra/opentelemetry";
import { RedisPubSubLive } from "~/core/infra/redis-pubsub";
import { S3ObjectStorageLive } from "~/core/infra/s3-object-storage";

export const ServerLayerLive = Layer.mergeAll(
  DatabaseLive,
  BullMqJobQueueLive,
  S3ObjectStorageLive,
  RedisPubSubLive,
  OpenTelemetryLive,
);

export const ServerRuntimeLive = ManagedRuntime.make(ServerLayerLive);
