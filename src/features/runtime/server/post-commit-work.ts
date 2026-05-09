import { Context, Effect, Layer, Schedule } from "effect";

import type { TaskStatusEvent } from "~/features/runtime/events/task-status-events";
import { EventPublisherService } from "~/features/runtime/server/commands";
import type {
  RuntimeExecutionJobPayload,
  RuntimeWakeUpJobPayload,
} from "~/server/services/queue";
import { QueueService } from "~/server/services/queue";
import { TelemetryService } from "~/server/services/telemetry";

export type PostCommitWorkSource =
  | "approve-task-run"
  | "cancel-task-run"
  | "handle-wake-up-call"
  | "reject-task-run"
  | "settle-worker-completion"
  | "settle-worker-failure"
  | "start-workflow-run";

export type PostCommitWork = {
  readonly executionJobs: readonly RuntimeExecutionJobPayload[];
  readonly source: PostCommitWorkSource;
  readonly taskStatusEvents: readonly TaskStatusEvent[];
  readonly wakeUpJobs: readonly RuntimeWakeUpJobPayload[];
  readonly workflowId: string;
};

type PostCommitWorkItem =
  | {
      readonly kind: "execution-job";
      readonly value: RuntimeExecutionJobPayload;
    }
  | {
      readonly kind: "wake-up-call-job";
      readonly value: RuntimeWakeUpJobPayload;
    }
  | { readonly kind: "task-status-event"; readonly value: TaskStatusEvent };

export type PostCommitWorkDeliveryError = {
  readonly _tag: "PostCommitWorkDeliveryError";
  readonly cause: unknown;
  readonly item: PostCommitWorkItem;
  readonly work: PostCommitWork;
};

type DeliveryDependencies = {
  readonly eventPublisher: Context.Tag.Service<typeof EventPublisherService>;
  readonly queue: Context.Tag.Service<typeof QueueService>;
  readonly retrySchedule: Schedule.Schedule<
    unknown,
    PostCommitWorkDeliveryError
  >;
  readonly telemetry: Context.Tag.Service<typeof TelemetryService>;
};

export type PostCommitWorkDeliveryAdapters = Pick<
  DeliveryDependencies,
  "eventPublisher" | "queue"
> &
  Partial<Pick<DeliveryDependencies, "retrySchedule" | "telemetry">>;

const defaultRetrySchedule = Schedule.exponential("50 millis", 2).pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(2)),
);

export class RuntimePostCommitWork extends Context.Tag("RuntimePostCommitWork")<
  RuntimePostCommitWork,
  {
    readonly deliver: (work: PostCommitWork) => Effect.Effect<void, never>;
  }
>() {
  static readonly deliver = (work: PostCommitWork) =>
    Effect.flatMap(RuntimePostCommitWork, (service) => service.deliver(work));

  static readonly layerWithSchedule = (
    retrySchedule: Schedule.Schedule<unknown, PostCommitWorkDeliveryError>,
  ) =>
    Layer.effect(
      RuntimePostCommitWork,
      Effect.gen(function* () {
        const queue = yield* QueueService;
        const eventPublisher = yield* EventPublisherService;
        const telemetry = yield* TelemetryService;
        return {
          deliver: (work) =>
            deliverPostCommitWork(work, {
              eventPublisher,
              queue,
              retrySchedule,
              telemetry,
            }),
        };
      }),
    );

  static readonly Live =
    RuntimePostCommitWork.layerWithSchedule(defaultRetrySchedule);

  static readonly Test = RuntimePostCommitWork.layerWithSchedule(
    Schedule.recurs(0),
  );
}

export function deliverPostCommitWorkBestEffort(
  work: PostCommitWork,
  adapters: PostCommitWorkDeliveryAdapters,
) {
  return deliverPostCommitWork(work, {
    eventPublisher: adapters.eventPublisher,
    queue: adapters.queue,
    retrySchedule: adapters.retrySchedule ?? defaultRetrySchedule,
    telemetry: adapters.telemetry ?? fallbackTelemetry,
  });
}

const fallbackTelemetry: Context.Tag.Service<typeof TelemetryService> = {
  config: {
    enabled: false,
    exporterEndpoint: null,
    serviceName: "faceless-factory-runtime",
  },
  postCommitDeliveryAttemptFailed: (details) =>
    Effect.logDebug(
      "Runtime Post-Commit Work delivery attempt failed",
      details,
    ),
  postCommitDeliveryExhausted: (details) =>
    Effect.logWarning("Runtime Post-Commit Work delivery exhausted", details),
};

function deliverPostCommitWork(
  work: PostCommitWork,
  dependencies: DeliveryDependencies,
) {
  return Effect.gen(function* () {
    yield* Effect.forEach(
      work.executionJobs,
      (value) =>
        deliverItem(work, { kind: "execution-job", value }, dependencies),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      work.wakeUpJobs,
      (value) =>
        deliverItem(work, { kind: "wake-up-call-job", value }, dependencies),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      work.taskStatusEvents,
      (value) =>
        deliverItem(work, { kind: "task-status-event", value }, dependencies),
      { concurrency: 1, discard: true },
    );
  });
}

function deliverItem(
  work: PostCommitWork,
  item: PostCommitWorkItem,
  dependencies: DeliveryDependencies,
) {
  let attempt = 0;
  return Effect.suspend(() => {
    attempt += 1;
    return deliverItemOnce(work, item, dependencies).pipe(
      Effect.tapError((error) =>
        dependencies.telemetry.postCommitDeliveryAttemptFailed(
          telemetryDetails(error, attempt),
        ),
      ),
    );
  }).pipe(
    Effect.retry(dependencies.retrySchedule),
    Effect.catchAll((error) =>
      dependencies.telemetry.postCommitDeliveryExhausted(
        telemetryDetails(error, attempt),
      ),
    ),
  );
}

function deliverItemOnce(
  work: PostCommitWork,
  item: PostCommitWorkItem,
  dependencies: DeliveryDependencies,
) {
  return (() => {
    switch (item.kind) {
      case "execution-job":
        return dependencies.queue.enqueueExecutionJob(item.value);
      case "wake-up-call-job":
        return dependencies.queue.enqueueWakeUpJob(item.value);
      case "task-status-event":
        return dependencies.eventPublisher.publishTaskStatusEvent(
          work.workflowId,
          item.value,
        );
    }
  })().pipe(
    Effect.mapError(
      (cause): PostCommitWorkDeliveryError => ({
        _tag: "PostCommitWorkDeliveryError",
        cause,
        item,
        work,
      }),
    ),
  );
}

function telemetryDetails(error: PostCommitWorkDeliveryError, attempt: number) {
  const identifiers = itemIdentifiers(error.item);
  return {
    attempt,
    cause: errorMessage(error.cause),
    kind: error.item.kind,
    source: error.work.source,
    workflowId: error.work.workflowId,
    ...identifiers,
  };
}

function itemIdentifiers(item: PostCommitWorkItem): {
  readonly branchIndex?: number;
  readonly jobId?: string;
  readonly nodeRunId?: string;
  readonly status?: string;
  readonly taskId?: string;
} {
  switch (item.kind) {
    case "execution-job":
      return {
        branchIndex: item.value.branchIndex,
        jobId: item.value.jobId,
        nodeRunId: item.value.nodeRunId,
        taskId: item.value.taskId,
      };
    case "wake-up-call-job":
      return {
        jobId: item.value.jobId,
        taskId: item.value.parentTaskId,
      };
    case "task-status-event":
      return {
        branchIndex: item.value.branchIndex,
        nodeRunId: item.value.nodeRunId,
        status: item.value.status,
        taskId: item.value.taskId,
      };
  }
}

function errorMessage(cause: unknown) {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "Unknown Post-Commit Work delivery failure.";
}
