import { env } from "~/env";

export const RUNTIME_QUEUE_NAME = "runtime";
export const RUNTIME_QUEUE_JOB_HISTORY_AGE_SECONDS = 60 * 60 * 24;
export const RUNTIME_QUEUE_WORKER_CONCURRENCY = 8;

export const workflowQueueConnection = {
  url: env.REDIS_URL,
};
