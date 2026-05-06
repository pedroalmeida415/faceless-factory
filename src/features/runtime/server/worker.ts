import { Worker, type WorkerOptions } from "bullmq";
import { sanitizeRuntimeProcessorOutcome } from "~/features/runtime/server/command-outcome";
import type {
  EventPublisherServiceForCommands,
  HandleWakeUpCallCommand,
  QueueServiceForCommands,
} from "~/features/runtime/server/command-types";
import type {
  RuntimeExecutionWorkerRepository,
  RuntimeProviderExecutor,
  RuntimeSettlementQueueForWorker,
} from "~/features/runtime/server/execution-worker";
import { createRuntimeExecutionWorker } from "~/features/runtime/server/execution-worker";
import {
  parseRuntimeJob,
  RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME,
  RUNTIME_EXECUTION_JOB_NAME,
  RUNTIME_FAILURE_SETTLEMENT_JOB_NAME,
  RUNTIME_WAKE_UP_JOB_NAME,
  type RuntimeCompletionSettlementJobPayload,
  type RuntimeExecutionJobPayload,
  type RuntimeFailureSettlementJobPayload,
  type RuntimeWakeUpJobPayload,
} from "~/server/services/queue";
import {
  RUNTIME_QUEUE_JOB_HISTORY_AGE_SECONDS,
  RUNTIME_QUEUE_NAME,
  RUNTIME_QUEUE_WORKER_CONCURRENCY,
  workflowQueueConnection,
} from "~/server/services/queue-config";

export const runtimeWorkerOptions: Omit<WorkerOptions, "connection"> = {
  concurrency: RUNTIME_QUEUE_WORKER_CONCURRENCY,
  maxStalledCount: 1,
  removeOnComplete: {
    age: RUNTIME_QUEUE_JOB_HISTORY_AGE_SECONDS,
    count: 100,
  },
  removeOnFail: {
    age: RUNTIME_QUEUE_JOB_HISTORY_AGE_SECONDS,
    count: 500,
  },
};

export type RuntimeJobPayload =
  | RuntimeCompletionSettlementJobPayload
  | RuntimeExecutionJobPayload
  | RuntimeFailureSettlementJobPayload
  | RuntimeWakeUpJobPayload;

export type RuntimeJobLike = {
  readonly data: unknown;
  readonly name: string;
};

export type RuntimeExecutionWorkerForProcessor = {
  readonly execute: (job: RuntimeExecutionJobPayload) => Promise<unknown>;
};

export type RuntimeCommandHandlerForProcessor = {
  readonly handleWakeUpCall: (
    command: HandleWakeUpCallCommand,
  ) => Promise<unknown>;
  readonly settleWorkerCompletion: (
    job: RuntimeCompletionSettlementJobPayload,
  ) => Promise<unknown>;
  readonly settleWorkerFailure: (
    job: RuntimeFailureSettlementJobPayload,
  ) => Promise<unknown>;
};

export function createRuntimeProcessor(input: {
  readonly executionWorker: RuntimeExecutionWorkerForProcessor;
  readonly orchestrator: RuntimeCommandHandlerForProcessor;
}) {
  return async (job: RuntimeJobLike) => {
    const parsed = parseRuntimeJob(job);
    if (!parsed.success) {
      throw new Error(parsed.error.message, { cause: parsed.error });
    }

    switch (parsed.job.name) {
      case RUNTIME_EXECUTION_JOB_NAME:
        return input.executionWorker.execute(parsed.job.data);
      case RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME:
        return sanitizeRuntimeProcessorOutcome(
          await input.orchestrator.settleWorkerCompletion(parsed.job.data),
        );
      case RUNTIME_FAILURE_SETTLEMENT_JOB_NAME:
        return sanitizeRuntimeProcessorOutcome(
          await input.orchestrator.settleWorkerFailure(parsed.job.data),
        );
      case RUNTIME_WAKE_UP_JOB_NAME:
        return sanitizeRuntimeProcessorOutcome(
          await input.orchestrator.handleWakeUpCall({
            ownerUserId: parsed.job.data.ownerUserId,
            settledParentTaskRunId: parsed.job.data.parentTaskRunId,
            workflowId: parsed.job.data.workflowId,
          }),
        );
      default:
        throw new Error(`Unknown runtime job name: ${job.name}`);
    }
  };
}

export function createRuntimeWorker(input: {
  readonly eventPublisher: EventPublisherServiceForCommands;
  readonly orchestrator: RuntimeCommandHandlerForProcessor;
  readonly providerExecutor: RuntimeProviderExecutor;
  readonly queue: QueueServiceForCommands & RuntimeSettlementQueueForWorker;
  readonly repository: RuntimeExecutionWorkerRepository;
}) {
  const executionWorker = createRuntimeExecutionWorker({
    eventPublisher: input.eventPublisher,
    providerExecutor: input.providerExecutor,
    repository: input.repository,
    settlementQueue: input.queue,
  });

  return new Worker(
    RUNTIME_QUEUE_NAME,
    createRuntimeProcessor({
      executionWorker,
      orchestrator: input.orchestrator,
    }),
    {
      connection: workflowQueueConnection,
      ...runtimeWorkerOptions,
    },
  );
}
