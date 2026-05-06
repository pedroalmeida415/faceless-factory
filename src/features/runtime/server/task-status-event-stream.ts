import { Chunk, Effect, Metric, Option, Stream } from "effect";
import type { TaskStatusEvent } from "~/features/runtime/events/task-status-events";
import { TaskStatusEventSchema } from "~/features/runtime/events/task-status-events";

export type WorkflowEventPubSubLike = {
  publish(channel: string, payload: string): Promise<unknown>;
};

export type WorkflowEventSubscriberLike = {
  subscribe(
    channel: string,
    handler: (payload: string) => void,
  ): Promise<unknown>;
  unsubscribe?(
    channel: string,
    handler: (payload: string) => void,
  ): Promise<unknown>;
};

export type WorkflowEventPublishError = {
  readonly _tag: "WorkflowEventPublishError";
  readonly cause: unknown;
  readonly channel: string;
  readonly taskRunId?: string;
  readonly workflowId: string;
};

export type WorkflowEventParseError = {
  readonly _tag: "WorkflowEventParseError";
  readonly cause: unknown;
  readonly payload: string;
};

export type WorkflowEventSubscribeError = {
  readonly _tag: "WorkflowEventSubscribeError";
  readonly cause: unknown;
  readonly channel: string;
  readonly workflowId: string;
};

export const workflowEventStreamMetrics = {
  parseFailures: Metric.counter("workflow_event_stream_parse_failures_total", {
    description: "Workflow Event Stream payload parse failures.",
    incremental: true,
  }),
  publishFailures: Metric.counter(
    "workflow_event_stream_publish_failures_total",
    {
      description: "Workflow Event Stream publish failures.",
      incremental: true,
    },
  ),
  subscribeFailures: Metric.counter(
    "workflow_event_stream_subscribe_failures_total",
    {
      description: "Workflow Event Stream subscribe failures.",
      incremental: true,
    },
  ),
} as const;

export type WorkflowEventParseTelemetry = {
  readonly source?: "parser" | "subscriber";
  readonly workflowId?: string;
};

export function workflowEventChannel(workflowId: string) {
  return `workflow-events:${workflowId}`;
}

export function createWorkflowEventPublisher(pubSub: WorkflowEventPubSubLike) {
  return {
    publishTaskStatusEvent(workflowId: string, event: TaskStatusEvent) {
      const channel = workflowEventChannel(workflowId);

      return Effect.try({
        try: () => JSON.stringify(TaskStatusEventSchema.parse(event)),
        catch: (cause): WorkflowEventPublishError => ({
          _tag: "WorkflowEventPublishError",
          cause,
          channel,
          taskRunId: event.taskRunId,
          workflowId,
        }),
      }).pipe(
        Effect.flatMap((payload) =>
          Effect.tryPromise({
            try: () => pubSub.publish(channel, payload),
            catch: (cause): WorkflowEventPublishError => ({
              _tag: "WorkflowEventPublishError",
              cause,
              channel,
              taskRunId: event.taskRunId,
              workflowId,
            }),
          }),
        ),
        Effect.asVoid,
        Effect.tapError(recordPublishFailure),
        Effect.withSpan("workflow-event-stream.publish", {
          attributes: {
            "workflow_runtime.task_run_id": event.taskRunId,
            "workflow_runtime.workflow_id": workflowId,
          },
        }),
      );
    },
  };
}

export function createWorkflowEventSubscriber(
  subscriber: WorkflowEventSubscriberLike,
) {
  return {
    subscribeTaskStatusEvents(workflowId: string) {
      const channel = workflowEventChannel(workflowId);

      return Stream.asyncScoped<
        TaskStatusEvent,
        WorkflowEventParseError | WorkflowEventSubscribeError
      >((emit) => {
        const handler = (payload: string) => {
          emit(
            parseTaskStatusEventPayloadEffect(payload, {
              source: "subscriber",
              workflowId,
            }).pipe(Effect.map(Chunk.of), Effect.mapError(Option.some)),
          );
        };

        return Effect.acquireRelease(
          Effect.tryPromise({
            try: () => subscriber.subscribe(channel, handler),
            catch: (cause): WorkflowEventSubscribeError => ({
              _tag: "WorkflowEventSubscribeError",
              cause,
              channel,
              workflowId,
            }),
          }).pipe(
            Effect.tapError(recordSubscribeFailure),
            Effect.withSpan("workflow-event-stream.subscribe", {
              attributes: {
                "workflow_runtime.workflow_id": workflowId,
              },
            }),
          ),
          () => {
            const unsubscribe = subscriber.unsubscribe;

            return unsubscribe
              ? Effect.promise(() => unsubscribe(channel, handler))
              : Effect.void;
          },
        );
      });
    },
  };
}

export function parseTaskStatusEventPayload(payload: string) {
  return Effect.runSync(parseTaskStatusEventPayloadEffect(payload));
}

export function parseTaskStatusEventPayloadEffect(
  payload: string,
  telemetry: WorkflowEventParseTelemetry = {},
) {
  return Effect.try({
    try: () => TaskStatusEventSchema.parse(JSON.parse(payload)),
    catch: (cause): WorkflowEventParseError => ({
      _tag: "WorkflowEventParseError",
      cause,
      payload,
    }),
  }).pipe(
    Effect.tapError((error) => recordParseFailure(error, telemetry)),
    Effect.withSpan("workflow-event-stream.parse"),
  );
}

function recordPublishFailure(error: WorkflowEventPublishError) {
  return Metric.update(
    workflowEventStreamMetrics.publishFailures.pipe(
      Metric.tagged("channel", error.channel),
      Metric.tagged("task_run_id", error.taskRunId ?? "none"),
      Metric.tagged("workflow_id", error.workflowId),
    ),
    1,
  ).pipe(
    Effect.zipRight(
      Effect.logWarning("Workflow Event Stream publish failed", {
        channel: error.channel,
        taskRunId: error.taskRunId,
        workflowId: error.workflowId,
      }),
    ),
  );
}

function recordSubscribeFailure(error: WorkflowEventSubscribeError) {
  return Metric.update(
    workflowEventStreamMetrics.subscribeFailures.pipe(
      Metric.tagged("channel", error.channel),
      Metric.tagged("workflow_id", error.workflowId),
    ),
    1,
  ).pipe(
    Effect.zipRight(
      Effect.logWarning("Workflow Event Stream subscribe failed", {
        channel: error.channel,
        workflowId: error.workflowId,
      }),
    ),
  );
}

function recordParseFailure(
  error: WorkflowEventParseError,
  telemetry: WorkflowEventParseTelemetry,
) {
  return Metric.update(
    workflowEventStreamMetrics.parseFailures.pipe(
      Metric.tagged("source", telemetry.source ?? "parser"),
      Metric.tagged("workflow_id", telemetry.workflowId ?? "none"),
    ),
    1,
  ).pipe(
    Effect.zipRight(
      Effect.logWarning("Workflow Event Stream payload parse failed", {
        payloadLength: error.payload.length,
        source: telemetry.source ?? "parser",
        workflowId: telemetry.workflowId,
      }),
    ),
  );
}
