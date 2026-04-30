import type { TaskStatusEvent } from "~/lib/workflow-runtime/runtime/task-status-events";
import { TaskStatusEventSchema } from "~/lib/workflow-runtime/runtime/task-status-events";

export type WorkflowEventPubSubLike = {
  publish(channel: string, payload: string): Promise<unknown>;
};

export function workflowEventChannel(workflowId: string) {
  return `workflow-events:${workflowId}`;
}

export function createWorkflowEventPublisher(pubSub: WorkflowEventPubSubLike) {
  return {
    async publishTaskStatusEvents(
      workflowId: string,
      events: readonly TaskStatusEvent[],
    ) {
      const channel = workflowEventChannel(workflowId);

      for (const event of events) {
        await pubSub.publish(
          channel,
          JSON.stringify(TaskStatusEventSchema.parse(event)),
        );
      }
    },
  };
}

export function parseTaskStatusEventPayload(payload: string) {
  return TaskStatusEventSchema.parse(JSON.parse(payload));
}
