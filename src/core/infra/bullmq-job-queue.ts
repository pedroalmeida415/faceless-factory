import { type JobsOptions, Queue } from "bullmq";
import { Effect, Layer } from "effect";
import {
  type EnqueueJobCommand,
  JobQueueInvalidJobIdError,
  JobQueuePublishError,
  JobQueueService,
  type JobRetentionPolicy,
} from "~/core/application/job-queue-service";
import { env } from "~/env";

type BullMqEnqueueOptions = JobsOptions & { readonly jobId: string };

export const BullMqJobQueueLive = Layer.scoped(
  JobQueueService,
  Effect.gen(function* () {
    const queues = new Map<string, Queue>();
    yield* Effect.addFinalizer(() => closeQueues(queues));

    return JobQueueService.of({
      enqueue: (command) =>
        Effect.gen(function* () {
          yield* validateJobId(command);
          const queue = getOrCreateQueue(queues, command.queueName);
          yield* Effect.tryPromise({
            try: () =>
              queue.add(
                command.jobName,
                command.payload,
                toBullMqOptions(command),
              ),
            catch: (cause) =>
              new JobQueuePublishError({
                cause,
                jobId: command.jobId,
                jobName: command.jobName,
                queueName: command.queueName,
              }),
          });
        }).pipe(Effect.asVoid),
    });
  }),
);

function getOrCreateQueue(queues: Map<string, Queue>, queueName: string) {
  const existingQueue = queues.get(queueName);
  if (existingQueue) {
    return existingQueue;
  }

  const queue = new Queue(queueName, {
    connection: { url: env.REDIS_URL },
  });
  queues.set(queueName, queue);

  return queue;
}

function closeQueues(queues: Map<string, Queue>) {
  return Effect.forEach(
    queues.values(),
    (queue) =>
      Effect.promise(() => queue.close()).pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning("BullMQ queue close failed", {
            cause: errorMessage(cause),
            queueName: queue.name,
          }),
        ),
      ),
    { discard: true },
  );
}

function validateJobId(command: EnqueueJobCommand) {
  if (!command.jobId.trim()) {
    return Effect.fail(
      new JobQueueInvalidJobIdError({
        jobId: command.jobId,
        jobName: command.jobName,
        message: "Job id must not be empty.",
        queueName: command.queueName,
      }),
    );
  }

  if (command.jobId.includes(":")) {
    return Effect.fail(
      new JobQueueInvalidJobIdError({
        jobId: command.jobId,
        jobName: command.jobName,
        message: "BullMQ job ids must not contain colons.",
        queueName: command.queueName,
      }),
    );
  }

  return Effect.void;
}

function toBullMqOptions(command: EnqueueJobCommand): BullMqEnqueueOptions {
  return {
    ...(command.attempts === undefined ? {} : { attempts: command.attempts }),
    ...(command.backoff
      ? {
          backoff: {
            delay: command.backoff.delayMs,
            type: command.backoff.type,
          },
        }
      : {}),
    ...(command.delayMs === undefined ? {} : { delay: command.delayMs }),
    jobId: command.jobId,
    ...(command.priority === undefined ? {} : { priority: command.priority }),
    ...(command.removeOnComplete === undefined
      ? {}
      : {
          removeOnComplete: toBullMqRetentionPolicy(command.removeOnComplete),
        }),
    ...(command.removeOnFail === undefined
      ? {}
      : { removeOnFail: toBullMqRetentionPolicy(command.removeOnFail) }),
  };
}

function toBullMqRetentionPolicy(
  policy: JobRetentionPolicy,
): JobsOptions["removeOnComplete"] {
  if (typeof policy !== "object") {
    return policy;
  }

  if (policy.ageSeconds === undefined) {
    return policy.count ?? true;
  }

  return {
    age: policy.ageSeconds,
    ...(policy.count === undefined ? {} : { count: policy.count }),
  };
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
