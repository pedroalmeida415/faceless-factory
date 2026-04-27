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
const WORKFLOW_REVIEW_REGENERATION_JOB_NAME = "regenerate-review-lane";
const WORKFLOW_EXECUTION_HISTORY_AGE_SECONDS = 60 * 60 * 24;

function toWorkflowJobId(...parts: readonly (number | string)[]) {
  return parts.map((part) => encodeURIComponent(String(part))).join("~");
}

export function createWorkflowContinuationJobId(params: {
  laneIndex?: number | null;
  reviewNodeId?: string | null;
  runId: string;
}) {
  return params.reviewNodeId &&
    params.laneIndex !== null &&
    params.laneIndex !== undefined
    ? toWorkflowJobId(
        params.runId,
        "resume",
        params.reviewNodeId,
        params.laneIndex ?? "all",
      )
    : toWorkflowJobId(params.runId, "resume", "all");
}

export function createWorkflowExecutionLaneJobId(params: {
  laneIndex: number;
  runId: string;
}) {
  return toWorkflowJobId(params.runId, "lane", params.laneIndex);
}

export function createWorkflowReviewRegenerationJobId(params: {
  attempt?: number | null;
  laneIndex: number;
  regenerationKey?: string | null;
  reviewNodeId: string;
  runId: string;
}) {
  return toWorkflowJobId(
    params.runId,
    "regenerate",
    params.reviewNodeId,
    params.laneIndex,
    params.attempt ?? "latest",
    params.regenerationKey ?? "pending",
  );
}

export type WorkflowExecutionJobData =
  | {
      request: StartWorkflowExecutionRequest;
      runId: string;
      type: "execute-run";
      userId: string;
    }
  | {
      attempt: number;
      laneIndex: number;
      reviewNodeId: string;
      runId: string;
      type: "regenerate-review-lane";
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

export function enqueueWorkflowExecutionJob(
  data: Extract<WorkflowExecutionJobData, { type: "execute-run" }>,
  options: { jobId?: string } = {},
) {
  return getWorkflowExecutionQueue().add(WORKFLOW_EXECUTION_JOB_NAME, data, {
    jobId: options.jobId ?? data.runId,
  });
}

export function enqueueWorkflowReviewRegenerationJob(
  data: Extract<WorkflowExecutionJobData, { type: "regenerate-review-lane" }>,
  options: { jobId?: string } = {},
) {
  return getWorkflowExecutionQueue().add(
    WORKFLOW_REVIEW_REGENERATION_JOB_NAME,
    data,
    {
      jobId: options.jobId ?? createWorkflowReviewRegenerationJobId(data),
    },
  );
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
