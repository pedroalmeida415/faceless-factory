import { Context, Data, type Effect } from "effect";

export const JobQueueName = {
  runtime: "runtime",
} as const;

export type JobQueueName = (typeof JobQueueName)[keyof typeof JobQueueName];

export type JobRetentionPolicy =
  | boolean
  | number
  | {
      readonly ageSeconds?: number;
      readonly count?: number;
    };

export type JobBackoffPolicy = {
  readonly delayMs: number;
  readonly type: "exponential" | "fixed";
};

export type EnqueueJobCommand = {
  readonly attempts?: number;
  readonly backoff?: JobBackoffPolicy;
  readonly delayMs?: number;
  readonly jobId: string;
  readonly jobName: string;
  readonly payload: unknown;
  readonly priority?: number;
  readonly queueName: JobQueueName;
  readonly removeOnComplete?: JobRetentionPolicy;
  readonly removeOnFail?: JobRetentionPolicy;
};

export class JobQueueInvalidJobIdError extends Data.TaggedError("JobQueueInvalidJobIdError")<{
  readonly jobId: string;
  readonly jobName: string;
  readonly message: string;
  readonly queueName: string;
}> {}

export class JobQueuePublishError extends Data.TaggedError("JobQueuePublishError")<{
  readonly cause: unknown;
  readonly jobId: string;
  readonly jobName: string;
  readonly queueName: string;
}> {}

export type JobQueueError = JobQueueInvalidJobIdError | JobQueuePublishError;

export type JobQueueServiceApi = {
  readonly enqueue: (command: EnqueueJobCommand) => Effect.Effect<void, JobQueueError>;
};

export class JobQueueService extends Context.Tag("JobQueueService")<JobQueueService, JobQueueServiceApi>() {}
