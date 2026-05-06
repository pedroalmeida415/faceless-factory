import { Context, Effect, Layer, Schedule } from "effect";

import type { TaskStatusEvent } from "~/lib/workflow-runtime/runtime/task-status-events";
import {
  WorkflowRuntimeEventPublisher,
  WorkflowRuntimeQueue,
} from "~/server/workflow-runtime/workflow-runtime-commands";
import type {
  WorkflowRuntimeExecutionJobPayload,
  WorkflowRuntimeWakeUpJobPayload,
} from "~/server/workflow-runtime/workflow-runtime-queue";
import { WorkflowRuntimeTelemetry } from "~/server/workflow-runtime/workflow-runtime-telemetry";

export type PostCommitWorkSource =
  | "approve-task-run"
  | "cancel-task-run"
  | "handle-wake-up-call"
  | "reject-task-run"
  | "settle-worker-completion"
  | "settle-worker-failure"
  | "start-workflow-run";

export type PostCommitWork = {
  readonly executionJobs: readonly WorkflowRuntimeExecutionJobPayload[];
  readonly source: PostCommitWorkSource;
  readonly taskStatusEvents: readonly TaskStatusEvent[];
  readonly wakeUpJobs: readonly WorkflowRuntimeWakeUpJobPayload[];
  readonly workflowId: string;
};

type PostCommitWorkItem =
  | {
      readonly kind: "execution-job";
      readonly value: WorkflowRuntimeExecutionJobPayload;
    }
  | {
      readonly kind: "wake-up-call-job";
      readonly value: WorkflowRuntimeWakeUpJobPayload;
    }
  | { readonly kind: "task-status-event"; readonly value: TaskStatusEvent };

export type PostCommitWorkDeliveryError = {
  readonly _tag: "PostCommitWorkDeliveryError";
  readonly cause: unknown;
  readonly item: PostCommitWorkItem;
  readonly work: PostCommitWork;
};

type DeliveryDependencies = {
  readonly eventPublisher: Context.Tag.Service<
    typeof WorkflowRuntimeEventPublisher
  >;
  readonly queue: Context.Tag.Service<typeof WorkflowRuntimeQueue>;
  readonly retrySchedule: Schedule.Schedule<
    unknown,
    PostCommitWorkDeliveryError
  >;
  readonly telemetry: Context.Tag.Service<typeof WorkflowRuntimeTelemetry>;
};

const defaultRetrySchedule = Schedule.exponential("50 millis", 2).pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(2)),
);

export class WorkflowRuntimePostCommitWork extends Context.Tag(
  "WorkflowRuntimePostCommitWork",
)<
  WorkflowRuntimePostCommitWork,
  {
    readonly deliver: (work: PostCommitWork) => Effect.Effect<void, never>;
  }
>() {
  static readonly deliver = (work: PostCommitWork) =>
    Effect.flatMap(WorkflowRuntimePostCommitWork, (service) =>
      service.deliver(work),
    );

  static readonly layerWithSchedule = (
    retrySchedule: Schedule.Schedule<unknown, PostCommitWorkDeliveryError>,
  ) =>
    Layer.effect(
      WorkflowRuntimePostCommitWork,
      Effect.gen(function* () {
        const queue = yield* WorkflowRuntimeQueue;
        const eventPublisher = yield* WorkflowRuntimeEventPublisher;
        const telemetry = yield* WorkflowRuntimeTelemetry;
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
    WorkflowRuntimePostCommitWork.layerWithSchedule(defaultRetrySchedule);
}

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
  return Effect.tryPromise({
    try: () => {
      switch (item.kind) {
        case "execution-job":
          return dependencies.queue.enqueueExecutionJobs([item.value]);
        case "wake-up-call-job":
          return dependencies.queue.enqueueWakeUpJobs([item.value]);
        case "task-status-event":
          return dependencies.eventPublisher.publishTaskStatusEvents(
            work.workflowId,
            [item.value],
          );
      }
    },
    catch: (cause): PostCommitWorkDeliveryError => ({
      _tag: "PostCommitWorkDeliveryError",
      cause,
      item,
      work,
    }),
  });
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
  readonly itemIndex?: number;
  readonly jobId?: string;
  readonly nodeExecutionId?: string;
  readonly status?: string;
  readonly taskRunId?: string;
} {
  switch (item.kind) {
    case "execution-job":
      return {
        itemIndex: item.value.itemIndex,
        jobId: item.value.jobId,
        nodeExecutionId: item.value.nodeExecutionId,
        taskRunId: item.value.taskRunId,
      };
    case "wake-up-call-job":
      return {
        jobId: item.value.jobId,
        taskRunId: item.value.parentTaskRunId,
      };
    case "task-status-event":
      return {
        itemIndex: item.value.itemIndex,
        nodeExecutionId: item.value.nodeExecutionId,
        status: item.value.status,
        taskRunId: item.value.taskRunId,
      };
  }
}

function errorMessage(cause: unknown) {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "Unknown Post-Commit Work delivery failure.";
}
