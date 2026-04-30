import { Queue } from "bullmq";

import { db } from "~/server/db";
import { getRedisClient } from "~/server/redis";
import { createWorkflowEventPublisher } from "~/server/workflow-runtime/task-status-event-stream";
import { createWorkflowRuntimeOrchestrator } from "~/server/workflow-runtime/workflow-runtime-orchestrator";
import { createWorkflowRuntimeQueueAdapter } from "~/server/workflow-runtime/workflow-runtime-queue";
import { createWorkflowRuntimeRepository } from "~/server/workflow-runtime/workflow-runtime-repository";
import {
  WORKFLOW_RUNTIME_JOB_HISTORY_AGE_SECONDS,
  WORKFLOW_RUNTIME_QUEUE_NAME,
  workflowRuntimeQueueConnection,
} from "~/server/workflow-runtime/workflow-runtime-worker";

const globalForWorkflowRuntime = globalThis as typeof globalThis & {
  __workflowRuntimeQueue?: Queue;
};

export function getWorkflowRuntimeQueue() {
  globalForWorkflowRuntime.__workflowRuntimeQueue ??= new Queue(
    WORKFLOW_RUNTIME_QUEUE_NAME,
    {
      connection: workflowRuntimeQueueConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          delay: 2_000,
          type: "exponential",
        },
        removeOnComplete: {
          age: WORKFLOW_RUNTIME_JOB_HISTORY_AGE_SECONDS,
          count: 100,
        },
        removeOnFail: {
          age: WORKFLOW_RUNTIME_JOB_HISTORY_AGE_SECONDS,
          count: 500,
        },
      },
    },
  );

  return globalForWorkflowRuntime.__workflowRuntimeQueue;
}

export async function createWorkflowRuntimeComposition() {
  const repository = createWorkflowRuntimeRepository(db);
  const queue = createWorkflowRuntimeQueueAdapter(getWorkflowRuntimeQueue());
  const eventPublisher = createWorkflowEventPublisher(await getRedisClient());

  return {
    eventPublisher,
    orchestrator: createWorkflowRuntimeOrchestrator({
      eventPublisher,
      queue,
      repository,
    }),
    queue,
    repository,
  };
}
