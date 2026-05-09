import { Worker, type WorkerOptions } from "bullmq";
import { Effect } from "effect";
import { sanitizeRuntimeProcessorOutcome } from "~/features/runtime/server/command-outcome";
import type {
  EventPublisherServiceForCommands,
  HandleWakeUpCallCommand,
  QueueServiceForCommands,
} from "~/features/runtime/server/command-types";
import {
  EventPublisherService,
  RuntimeCommands,
} from "~/features/runtime/server/commands";
import type {
  RuntimeExecutionWorkerRepository,
  RuntimeProviderExecutor,
  RuntimeSettlementQueueForWorker,
} from "~/features/runtime/server/execution-worker";
import { createRuntimeExecutionWorker } from "~/features/runtime/server/execution-worker";
import { createRuntimeProviderExecutor } from "~/features/runtime/server/provider-executor";
import { createRuntimeRepositoryFromDatabase } from "~/features/runtime/server/repository";
import { ServerRuntime } from "~/server/effect";
import { DatabaseService } from "~/server/services/database";
import {
  createWorkflowQueueAdapter,
  getWorkflowQueue,
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
import { VertexAiService } from "~/server/services/vertex";

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
            settledParentTaskId: parsed.job.data.parentTaskId,
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

async function startRuntimeWorker() {
  const worker = await ServerRuntime.runPromise(
    Effect.gen(function* () {
      const commands = yield* RuntimeCommands;
      const database = yield* DatabaseService;
      const eventPublisher = yield* EventPublisherService;
      const vertexAi = yield* VertexAiService;

      return createRuntimeWorker({
        eventPublisher,
        orchestrator: {
          handleWakeUpCall: (command) =>
            ServerRuntime.runPromise(commands.handleWakeUpCall(command)),
          settleWorkerCompletion: (job) =>
            ServerRuntime.runPromise(commands.settleWorkerCompletion(job)),
          settleWorkerFailure: (job) =>
            ServerRuntime.runPromise(commands.settleWorkerFailure(job)),
        },
        providerExecutor: createRuntimeProviderExecutor({ vertexAi }),
        queue: createWorkflowQueueAdapter(getWorkflowQueue()),
        repository: createRuntimeRepositoryFromDatabase(database),
      });
    }),
  );

  worker.on("completed", (job) => {
    console.info(`Runtime job ${job.id} completed.`);
  });

  worker.on("failed", (job, error) => {
    console.error(`Runtime job ${job?.id ?? "unknown"} failed`, error);
  });

  worker.on("error", (error) => {
    console.error("Runtime worker error", error);
  });

  await worker.waitUntilReady();
  console.info("Runtime worker ready", {
    concurrency: RUNTIME_QUEUE_WORKER_CONCURRENCY,
    queue: RUNTIME_QUEUE_NAME,
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.info("Runtime worker shutting down", { signal });
    await worker.close();
    await ServerRuntime.dispose();
  };

  process.once("SIGINT", (signal) => {
    void shutdown(signal).finally(() => process.exit(0));
  });
  process.once("SIGTERM", (signal) => {
    void shutdown(signal).finally(() => process.exit(0));
  });

  return worker;
}

if (import.meta.main) {
  startRuntimeWorker().catch((cause: unknown) => {
    console.error("Runtime worker failed to start", cause);
    process.exit(1);
  });
}
