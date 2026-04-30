import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { TaskStatusEvent } from "~/lib/workflow-runtime/runtime/task-status-events";
import {
  createWorkflowEventPublisher,
  parseTaskStatusEventPayload,
  workflowEventChannel,
} from "~/server/workflow-runtime/task-status-event-stream";

describe("workflow runtime Task Status Event Pub/Sub seam", () => {
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
      taskStatusEvent({ status: "RUNNING", taskRunId: "task-run-1" }),
      taskStatusEvent({
        output: {
          assetId: "asset-1",
          cdnUrl: "https://cdn.example.com/assets/asset-1.png",
          contentType: "image/png",
          kind: "cdn-asset",
        },
        status: "PENDING_REVIEW",
        taskRunId: "task-run-2",
      }),
    ] satisfies TaskStatusEvent[];

    await publisher.publishTaskStatusEvents("workflow-123", events);

    assert.deepEqual(
      pubSub.published.map((message) => message.channel),
      ["workflow-events:workflow-123", "workflow-events:workflow-123"],
    );
    assert.deepEqual(
      pubSub.published.map((message) => JSON.parse(message.payload)),
      events,
    );
  });

  test("publishes no messages for an empty event list", async () => {
    const pubSub = createFakePubSub();
    const publisher = createWorkflowEventPublisher(pubSub);

    await publisher.publishTaskStatusEvents("workflow-123", []);

    assert.deepEqual(pubSub.published, []);
  });

  test("parses incoming Task Status Event payloads through the runtime schema", () => {
    const event = taskStatusEvent({ status: "APPROVED" });

    assert.deepEqual(parseTaskStatusEventPayload(JSON.stringify(event)), event);
    assert.throws(() =>
      parseTaskStatusEventPayload(
        JSON.stringify({ ...event, attempt: -1, status: "not-a-status" }),
      ),
    );
    assert.throws(() => parseTaskStatusEventPayload("not-json"));
  });
});

function createFakePubSub() {
  const published: Array<{ channel: string; payload: string }> = [];

  return {
    published,
    async publish(channel: string, payload: string) {
      published.push({ channel, payload });
      return published.length;
    },
  };
}

function taskStatusEvent(
  overrides: Partial<TaskStatusEvent> = {},
): TaskStatusEvent {
  return {
    attempt: 0,
    itemIndex: 0,
    nodeExecutionId: "node-execution-1",
    status: "QUEUED",
    taskRunId: "task-run-1",
    ...overrides,
  };
}
