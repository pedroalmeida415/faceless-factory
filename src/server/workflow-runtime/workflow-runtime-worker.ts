import { Worker, type WorkerOptions } from "bullmq";
import { Effect } from "effect";

import { env } from "~/env";
import { sanitizeWorkflowRuntimeProcessorOutcome } from "~/server/workflow-runtime/workflow-runtime-command-outcome";
import type {
  WorkflowRuntimeExecutionWorkerRepository,
  WorkflowRuntimeProviderExecutor,
  WorkflowRuntimeSettlementQueueForWorker,
} from "~/server/workflow-runtime/workflow-runtime-execution-worker";
import { createWorkflowRuntimeExecutionWorker } from "~/server/workflow-runtime/workflow-runtime-execution-worker";
import type {
  HandleWakeUpCallCommand,
  WorkflowRuntimeEventPublisherForOrchestrator,
  WorkflowRuntimeQueueForOrchestrator,
} from "~/server/workflow-runtime/workflow-runtime-orchestrator";
import {
  parseWorkflowRuntimeJob,
  WORKFLOW_RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME,
  WORKFLOW_RUNTIME_EXECUTION_JOB_NAME,
  WORKFLOW_RUNTIME_FAILURE_SETTLEMENT_JOB_NAME,
  WORKFLOW_RUNTIME_WAKE_UP_JOB_NAME,
  type WorkflowRuntimeCompletionSettlementJobPayload,
  type WorkflowRuntimeExecutionJobPayload,
  type WorkflowRuntimeFailureSettlementJobPayload,
  type WorkflowRuntimeWakeUpJobPayload,
} from "~/server/workflow-runtime/workflow-runtime-queue";
import type { WorkflowRuntimeRepositoryFailure } from "~/server/workflow-runtime/workflow-runtime-repository";

export const WORKFLOW_RUNTIME_QUEUE_NAME = "workflow-runtime";
export const WORKFLOW_RUNTIME_JOB_HISTORY_AGE_SECONDS = 60 * 60 * 24;
export const WORKFLOW_RUNTIME_WORKER_CONCURRENCY = 8;

export const workflowRuntimeQueueConnection = {
  url: env.REDIS_URL,
};

export const workflowRuntimeWorkerOptions: Omit<WorkerOptions, "connection"> = {
  concurrency: WORKFLOW_RUNTIME_WORKER_CONCURRENCY,
  maxStalledCount: 1,
  removeOnComplete: {
    age: WORKFLOW_RUNTIME_JOB_HISTORY_AGE_SECONDS,
    count: 100,
  },
  removeOnFail: {
    age: WORKFLOW_RUNTIME_JOB_HISTORY_AGE_SECONDS,
    count: 500,
  },
};

export type WorkflowRuntimeJobPayload =
  | WorkflowRuntimeCompletionSettlementJobPayload
  | WorkflowRuntimeExecutionJobPayload
  | WorkflowRuntimeFailureSettlementJobPayload
  | WorkflowRuntimeWakeUpJobPayload;

export type WorkflowRuntimeJobLike = {
  readonly data: unknown;
  readonly name: string;
};

export type WorkflowRuntimeExecutionWorkerForProcessor = {
  readonly execute: (
    job: WorkflowRuntimeExecutionJobPayload,
  ) => Promise<unknown>;
};

export type WorkflowRuntimeOrchestratorForProcessor = {
  readonly handleWakeUpCall: (
    command: HandleWakeUpCallCommand,
  ) => Promise<unknown>;
  readonly settleWorkerCompletion: (
    job: WorkflowRuntimeCompletionSettlementJobPayload,
  ) => Promise<unknown>;
  readonly settleWorkerFailure: (
    job: WorkflowRuntimeFailureSettlementJobPayload,
  ) => Promise<unknown>;
};

export type WorkflowRuntimeQueuedTaskRunRepository = {
  readonly listQueuedTaskRunJobs: (command: {
    readonly limit: number;
  }) => Effect.Effect<
    readonly WorkflowRuntimeExecutionJobPayload[],
    WorkflowRuntimeRepositoryFailure
  >;
};

export type WorkflowRuntimeExecutionQueue = {
  readonly enqueueExecutionJobs: (
    jobs: readonly WorkflowRuntimeExecutionJobPayload[],
  ) => Promise<void>;
};

export function createWorkflowRuntimeProcessor(input: {
  readonly executionWorker: WorkflowRuntimeExecutionWorkerForProcessor;
  readonly orchestrator: WorkflowRuntimeOrchestratorForProcessor;
}) {
  return async (job: WorkflowRuntimeJobLike) => {
    const parsed = parseWorkflowRuntimeJob(job);
    if (!parsed.success) {
      throw new Error(parsed.error.message, { cause: parsed.error });
    }

    switch (parsed.job.name) {
      case WORKFLOW_RUNTIME_EXECUTION_JOB_NAME:
        return input.executionWorker.execute(parsed.job.data);
      case WORKFLOW_RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME:
        return sanitizeWorkflowRuntimeProcessorOutcome(
          await input.orchestrator.settleWorkerCompletion(parsed.job.data),
        );
      case WORKFLOW_RUNTIME_FAILURE_SETTLEMENT_JOB_NAME:
        return sanitizeWorkflowRuntimeProcessorOutcome(
          await input.orchestrator.settleWorkerFailure(parsed.job.data),
        );
      case WORKFLOW_RUNTIME_WAKE_UP_JOB_NAME:
        return sanitizeWorkflowRuntimeProcessorOutcome(
          await input.orchestrator.handleWakeUpCall({
            ownerUserId: parsed.job.data.ownerUserId,
            settledParentTaskRunId: parsed.job.data.parentTaskRunId,
            workflowId: parsed.job.data.workflowId,
          }),
        );
      default:
        throw new Error(`Unknown workflow runtime job name: ${job.name}`);
    }
  };
}

export async function sweepQueuedTaskRunJobs(input: {
  readonly limit: number;
  readonly queue: WorkflowRuntimeExecutionQueue;
  readonly repository: WorkflowRuntimeQueuedTaskRunRepository;
}): Promise<{ readonly enqueued: number }> {
  const jobs = await Effect.runPromise(
    input.repository.listQueuedTaskRunJobs({
      limit: input.limit,
    }),
  );
  await input.queue.enqueueExecutionJobs(jobs);

  return { enqueued: jobs.length };
}

export function createWorkflowRuntimeWorker(input: {
  readonly eventPublisher: WorkflowRuntimeEventPublisherForOrchestrator;
  readonly orchestrator: WorkflowRuntimeOrchestratorForProcessor;
  readonly providerExecutor: WorkflowRuntimeProviderExecutor;
  readonly queue: WorkflowRuntimeQueueForOrchestrator &
    WorkflowRuntimeSettlementQueueForWorker;
  readonly repository: WorkflowRuntimeExecutionWorkerRepository;
}) {
  const executionWorker = createWorkflowRuntimeExecutionWorker({
    eventPublisher: input.eventPublisher,
    providerExecutor: input.providerExecutor,
    repository: input.repository,
    settlementQueue: input.queue,
  });

  return new Worker(
    WORKFLOW_RUNTIME_QUEUE_NAME,
    createWorkflowRuntimeProcessor({
      executionWorker,
      orchestrator: input.orchestrator,
    }),
    {
      connection: workflowRuntimeQueueConnection,
      ...workflowRuntimeWorkerOptions,
    },
  );
}
