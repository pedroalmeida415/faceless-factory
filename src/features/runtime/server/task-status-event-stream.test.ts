import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Effect, Logger, Metric, Stream } from "effect";

import type { TaskStatusEvent } from "~/features/runtime/events/task-status-events";
import {
  createWorkflowEventPublisher,
  createWorkflowEventSubscriber,
  parseTaskStatusEventPayloadEffect,
  workflowEventChannel,
  workflowEventStreamMetrics,
} from "~/features/runtime/server/task-status-event-stream";

describe("runtime Task Status Event Pub/Sub seam", () => {
  test("scopes workflow event channels by Workflow id", () => {
    assert.equal(
      workflowEventChannel("workflow-123"),
      "workflow-events:workflow-123",
    );
  });

  test("publishes serialized Task Status Events to the workflow channel", async () => {
    const pubSub = createFakePubSub();
    const publisher = createWorkflowEventPublisher(pubSub);
    const events = [
      taskStatusEvent({ status: "RUNNING", taskId: "task-run-1" }),
      taskStatusEvent({
        output: {
          assetId: "asset-1",
          cdnUrl: "https://cdn.example.com/assets/asset-1.png",
          contentType: "image/png",
          kind: "cdn-asset",
        },
        status: "PENDING_REVIEW",
        taskId: "task-run-2",
      }),
    ] satisfies TaskStatusEvent[];

    for (const event of events) {
      await Effect.runPromise(
        publisher.publishTaskStatusEvent("workflow-123", event),
      );
    }

    assert.deepEqual(
      pubSub.published.map((message) => message.channel),
      ["workflow-events:workflow-123", "workflow-events:workflow-123"],
    );
    assert.deepEqual(
      pubSub.published.map((message) => JSON.parse(message.payload)),
      events,
    );
  });

  test("publishes one Task Status Event as an Effect", async () => {
    const pubSub = createFakePubSub();
    const publisher = createWorkflowEventPublisher(pubSub);
    const event = taskStatusEvent({
      status: "RUNNING",
      taskId: "task-run-1",
    });

    await Effect.runPromise(
      publisher.publishTaskStatusEvent("workflow-123", event),
    );

    assert.deepEqual(pubSub.published, [
      {
        channel: "workflow-events:workflow-123",
        payload: JSON.stringify(event),
      },
    ]);
  });

  test("returns typed Effect failures for invalid publication and parse payloads", async () => {
    const pubSub = createFakePubSub();
    const publisher = createWorkflowEventPublisher(pubSub);
    const invalidEvent = {
      ...taskStatusEvent(),
      branchIndex: -1,
    } as TaskStatusEvent;

    const publishExit = await Effect.runPromiseExit(
      publisher
        .publishTaskStatusEvent("workflow-123", invalidEvent)
        .pipe(Effect.provide(silentTestLogger)),
    );
    const parseExit = await Effect.runPromiseExit(
      parseTaskStatusEventPayloadEffect("not-json").pipe(
        Effect.provide(silentTestLogger),
      ),
    );

    assert.equal(publishExit._tag, "Failure");
    assert.match(String(publishExit.cause), /WorkflowEventPublishError/);
    assert.equal(parseExit._tag, "Failure");
    assert.match(String(parseExit.cause), /WorkflowEventParseError/);
    assert.deepEqual(pubSub.published, []);
  });

  test("returns typed Effect failures when Redis publish rejects", async () => {
    const pubSub = createFakePubSub({ failPublish: true });
    const publisher = createWorkflowEventPublisher(pubSub);
    const workflowId = "workflow-publish-failure-metric";
    const event = taskStatusEvent({ taskId: "task-run-publish-failure" });

    const exit = await Effect.runPromiseExit(
      publisher
        .publishTaskStatusEvent(workflowId, event)
        .pipe(Effect.provide(silentTestLogger)),
    );

    assert.equal(exit._tag, "Failure");
    assert.match(String(exit.cause), /WorkflowEventPublishError/);
    assert.equal(
      await metricCount(
        workflowEventStreamMetrics.publishFailures.pipe(
          Metric.tagged("channel", workflowEventChannel(workflowId)),
          Metric.tagged("task_id", event.taskId),
          Metric.tagged("workflow_id", workflowId),
        ),
      ),
      1,
    );
  });

  test("records subscribe failure metrics through the subscription seam", async () => {
    const redis = createFakeSubscriber({ failSubscribe: true });
    const subscriber = createWorkflowEventSubscriber(redis);
    const workflowId = "workflow-subscribe-failure-metric";

    const exit = await Effect.runPromiseExit(
      subscriber
        .subscribeTaskStatusEvents(workflowId)
        .pipe(Stream.runDrain, Effect.provide(silentTestLogger)),
    );

    assert.equal(exit._tag, "Failure");
    assert.match(String(exit.cause), /WorkflowEventSubscribeError/);
    assert.equal(
      await metricCount(
        workflowEventStreamMetrics.subscribeFailures.pipe(
          Metric.tagged("channel", workflowEventChannel(workflowId)),
          Metric.tagged("workflow_id", workflowId),
        ),
      ),
      1,
    );
  });

  test("surfaces invalid subscribed payloads as typed stream failures", async () => {
    const redis = createFakeSubscriber();
    const subscriber = createWorkflowEventSubscriber(redis);
    const workflowId = "workflow-subscriber-parse-failure-metric";

    const exitPromise = Effect.runPromiseExit(
      subscriber
        .subscribeTaskStatusEvents(workflowId)
        .pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.provide(silentTestLogger),
        ),
    );

    await redis.awaitSubscription();

    assert.doesNotThrow(() => {
      redis.emit(workflowEventChannel(workflowId), "not-json");
    });

    const exit = await exitPromise;

    assert.equal(exit._tag, "Failure");
    assert.match(String(exit.cause), /WorkflowEventParseError/);
    assert.equal(
      await metricCount(
        workflowEventStreamMetrics.parseFailures.pipe(
          Metric.tagged("source", "subscriber"),
          Metric.tagged("workflow_id", workflowId),
        ),
      ),
      1,
    );
  });

  test("subscribes to Redis Pub/Sub payloads and emits parsed Task Status Events", async () => {
    const redis = createFakeSubscriber();
    const subscriber = createWorkflowEventSubscriber(redis);
    const event = taskStatusEvent({
      status: "RUNNING",
      taskId: "task-run-1",
    });

    const eventsPromise = Effect.runPromise(
      subscriber
        .subscribeTaskStatusEvents("workflow-123")
        .pipe(Stream.take(1), Stream.runCollect),
    );

    await redis.awaitSubscription();

    redis.emit("workflow-events:workflow-123", JSON.stringify(event));

    assert.deepEqual(redis.subscriptions, ["workflow-events:workflow-123"]);
    assert.deepEqual(Array.from(await eventsPromise), [event]);
  });

  test("parses incoming Task Status Event payloads through the runtime schema", async () => {
    const event = taskStatusEvent({ status: "APPROVED" });

    assert.deepEqual(
      await Effect.runPromise(
        parseTaskStatusEventPayloadEffect(JSON.stringify(event)).pipe(
          Effect.provide(silentTestLogger),
        ),
      ),
      event,
    );
    assert.equal(
      (
        await Effect.runPromiseExit(
          parseTaskStatusEventPayloadEffect(
            JSON.stringify({
              ...event,
              unexpectedField: -1,
              status: "not-a-status",
            }),
          ).pipe(Effect.provide(silentTestLogger)),
        )
      )._tag,
      "Failure",
    );
    assert.equal(
      (
        await Effect.runPromiseExit(
          parseTaskStatusEventPayloadEffect("not-json").pipe(
            Effect.provide(silentTestLogger),
          ),
        )
      )._tag,
      "Failure",
    );
  });
});

function createFakePubSub(options: { readonly failPublish?: boolean } = {}) {
  const published: Array<{ channel: string; payload: string }> = [];

  return {
    published,
    async publish(channel: string, payload: string) {
      if (options.failPublish) {
        throw new Error("forced Redis publish failure");
      }

      published.push({ channel, payload });
      return published.length;
    },
  };
}

const silentTestLogger = Logger.replace(Logger.defaultLogger, Logger.none);

async function metricCount(
  metric: typeof workflowEventStreamMetrics.parseFailures,
) {
  const state = await Effect.runPromise(Metric.value(metric));

  return state.count;
}

function createFakeSubscriber(
  options: { readonly failSubscribe?: boolean } = {},
) {
  const subscriptions: string[] = [];
  const handlers = new Map<string, (payload: string) => void>();
  let resolveSubscription: (() => void) | undefined;
  const subscribed = new Promise<void>((resolve) => {
    resolveSubscription = resolve;
  });

  return {
    subscriptions,
    awaitSubscription: () => subscribed,
    emit(channel: string, payload: string) {
      handlers.get(channel)?.(payload);
    },
    async subscribe(channel: string, handler: (payload: string) => void) {
      if (options.failSubscribe) {
        throw new Error("forced Redis subscribe failure");
      }

      subscriptions.push(channel);
      handlers.set(channel, handler);
      resolveSubscription?.();
    },
  };
}

function taskStatusEvent(
  overrides: Partial<TaskStatusEvent> = {},
): TaskStatusEvent {
  return {
    branchIndex: 0,
    nodeRunId: "node-execution-1",
    status: "QUEUED",
    taskId: "task-run-1",
    ...overrides,
  };
}
