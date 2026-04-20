import {
  type Processor,
  Queue,
  QueueEvents,
  Worker,
  type WorkerOptions,
} from "bullmq";

import { env } from "~/env";
import type { StartWorkflowExecutionRequest } from "~/lib/workflow/execution/types";

const WORKFLOW_EXECUTION_QUEUE_NAME = "workflow-execution";
const WORKFLOW_EXECUTION_JOB_NAME = "execute-run";
const WORKFLOW_EXECUTION_HISTORY_AGE_SECONDS = 60 * 60 * 24;

export type WorkflowExecutionJobData = {
  request: StartWorkflowExecutionRequest;
  runId: string;
  userId: string;
};

const workflowQueueConnection = {
  url: env.REDIS_URL,
};

const workflowWorkerOptions: Omit<WorkerOptions, "connection"> = {
  concurrency: 1,
  maxStalledCount: 0,
  removeOnComplete: {
    age: WORKFLOW_EXECUTION_HISTORY_AGE_SECONDS,
    count: 100,
  },
  removeOnFail: {
    age: WORKFLOW_EXECUTION_HISTORY_AGE_SECONDS,
    count: 500,
  },
};

const globalForWorkflowQueue = globalThis as typeof globalThis & {
  __workflowExecutionQueue?: Queue<WorkflowExecutionJobData>;
};

export function getWorkflowExecutionQueue() {
  globalForWorkflowQueue.__workflowExecutionQueue ??= new Queue(
    WORKFLOW_EXECUTION_QUEUE_NAME,
    {
      connection: workflowQueueConnection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: workflowWorkerOptions.removeOnComplete,
        removeOnFail: workflowWorkerOptions.removeOnFail,
      },
    },
  );

  return globalForWorkflowQueue.__workflowExecutionQueue;
}

export function enqueueWorkflowExecutionJob(data: WorkflowExecutionJobData) {
  return getWorkflowExecutionQueue().add(WORKFLOW_EXECUTION_JOB_NAME, data, {
    jobId: data.runId,
  });
}

export function getWorkflowExecutionJob(jobId: string) {
  return getWorkflowExecutionQueue().getJob(jobId);
}

export function createWorkflowExecutionWorker(
  processor: Processor<WorkflowExecutionJobData, void, string>,
) {
  return new Worker(WORKFLOW_EXECUTION_QUEUE_NAME, processor, {
    connection: workflowQueueConnection,
    ...workflowWorkerOptions,
  });
}

export function createWorkflowExecutionQueueEvents() {
  return new QueueEvents(WORKFLOW_EXECUTION_QUEUE_NAME, {
    connection: workflowQueueConnection,
  });
}
