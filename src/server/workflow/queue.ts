import { type Processor, Queue, Worker, type WorkerOptions } from "bullmq";

import { env } from "~/env";

const WORKFLOW_EXECUTION_QUEUE_NAME = "workflow-execution";
const WORKFLOW_TASK_RUN_JOB_NAME = "execute-task-run";
const WORKFLOW_EXECUTION_HISTORY_AGE_SECONDS = 60 * 60 * 24;

export type WorkflowExecutionJobData = {
  executionId: string;
  taskRunId: string;
  type: "execute-task-run";
  userId: string;
};

const workflowQueueConnection = {
  url: env.REDIS_URL,
};

const workflowWorkerOptions: Omit<WorkerOptions, "connection"> = {
  concurrency: 8,
  maxStalledCount: 1,
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
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 2_000,
        },
        removeOnComplete: workflowWorkerOptions.removeOnComplete,
        removeOnFail: workflowWorkerOptions.removeOnFail,
      },
    },
  );

  return globalForWorkflowQueue.__workflowExecutionQueue;
}

export function enqueueWorkflowTaskRunJob(
  data: WorkflowExecutionJobData,
  options: { jobId?: string } = {},
) {
  return getWorkflowExecutionQueue().add(WORKFLOW_TASK_RUN_JOB_NAME, data, {
    jobId: options.jobId ?? data.taskRunId,
  });
}

export function createWorkflowExecutionWorker(
  processor: Processor<WorkflowExecutionJobData, void, string>,
) {
  return new Worker(WORKFLOW_EXECUTION_QUEUE_NAME, processor, {
    connection: workflowQueueConnection,
    ...workflowWorkerOptions,
  });
}
