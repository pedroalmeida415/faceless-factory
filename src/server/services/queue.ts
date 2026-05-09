import { Queue } from "bullmq";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import type {
  TaskFailureReason,
  TaskSettlementFailureSource,
} from "~/features/runtime/domain/task-state";
import {
  buildExecutionJobId,
  buildOrchestratorEventId,
  buildWakeUpJobId,
} from "~/features/runtime/events/task-status-events";
import {
  RUNTIME_QUEUE_JOB_HISTORY_AGE_SECONDS,
  RUNTIME_QUEUE_NAME,
  workflowQueueConnection,
} from "~/server/services/queue-config";

const globalForServerQueue = globalThis as typeof globalThis & {
  __workflowQueue?: Queue;
};

export function getWorkflowQueue() {
  globalForServerQueue.__workflowQueue ??= new Queue(RUNTIME_QUEUE_NAME, {
    connection: workflowQueueConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        delay: 2_000,
        type: "exponential",
      },
      removeOnComplete: {
        age: RUNTIME_QUEUE_JOB_HISTORY_AGE_SECONDS,
        count: 100,
      },
      removeOnFail: {
        age: RUNTIME_QUEUE_JOB_HISTORY_AGE_SECONDS,
        count: 500,
      },
    },
  });

  return globalForServerQueue.__workflowQueue;
}

export const RUNTIME_EXECUTION_JOB_NAME = "execute-task-run";
export const RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME =
  "settle-task-run-completion";
export const RUNTIME_FAILURE_SETTLEMENT_JOB_NAME = "settle-task-run-failure";
export const RUNTIME_WAKE_UP_JOB_NAME = "wake-up-task-run-children";

const jobIdSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes(":"), {
    message: "BullMQ job ids must not contain colons.",
  });
const nonEmptyStringSchema = z.string().min(1);
const branchIndexSchema = z.number().int().nonnegative();

export type RuntimeExecutionJobPayload = {
  readonly branchIndex: number;
  readonly jobId: string;
  readonly nodeRunId: string;
  readonly ownerUserId: string;
  readonly taskId: string;
  readonly workflowId: string;
};

export const RuntimeExecutionJobPayloadSchema = z.object({
  branchIndex: branchIndexSchema,
  jobId: jobIdSchema,
  nodeRunId: nonEmptyStringSchema,
  ownerUserId: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
  workflowId: nonEmptyStringSchema,
});

export type RuntimeWakeUpJobPayload = {
  readonly jobId: string;
  readonly ownerUserId: string;
  readonly parentTaskId: string;
  readonly workflowId: string;
};

export type QueueServiceApi = {
  readonly enqueueExecutionJob: (
    job: RuntimeExecutionJobPayload,
  ) => Effect.Effect<void, unknown>;
  readonly enqueueWakeUpJob: (
    job: RuntimeWakeUpJobPayload,
  ) => Effect.Effect<void, unknown>;
};

export class QueueService extends Context.Tag("QueueService")<
  QueueService,
  QueueServiceApi
>() {
  static readonly Test = Layer.succeed(this, {
    enqueueExecutionJob: () => Effect.void,
    enqueueWakeUpJob: () => Effect.void,
  });
}

export const RuntimeWakeUpJobPayloadSchema = z.object({
  jobId: jobIdSchema,
  ownerUserId: nonEmptyStringSchema,
  parentTaskId: nonEmptyStringSchema,
  workflowId: nonEmptyStringSchema,
});

type RuntimeGeneratedPrimaryAssetPayloadBase = {
  readonly assetId: string;
  readonly contentType: string;
  readonly externalUri?: string | null;
  readonly fileName: string;
  readonly model?: string | null;
  readonly sizeBytes: number;
  readonly stagedStorageKey?: string | null;
  readonly storageKey?: string | null;
  readonly storageProvider: string;
};

export type RuntimeGeneratedPrimaryAssetPayload =
  | (RuntimeGeneratedPrimaryAssetPayloadBase & {
      readonly kind: "text";
      readonly text: string;
    })
  | (RuntimeGeneratedPrimaryAssetPayloadBase & {
      readonly cdnUrl: string;
      readonly kind: "image" | "video";
    });

const RuntimeGeneratedPrimaryAssetPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    assetId: nonEmptyStringSchema,
    contentType: nonEmptyStringSchema,
    externalUri: z.string().nullable().optional(),
    fileName: nonEmptyStringSchema,
    kind: z.literal("text"),
    model: z.string().nullable().optional(),
    sizeBytes: z.number().int().nonnegative(),
    stagedStorageKey: z.string().nullable().optional(),
    storageKey: z.string().nullable().optional(),
    storageProvider: nonEmptyStringSchema,
    text: z.string(),
  }),
  z.object({
    assetId: nonEmptyStringSchema,
    cdnUrl: nonEmptyStringSchema,
    contentType: nonEmptyStringSchema,
    externalUri: z.string().nullable().optional(),
    fileName: nonEmptyStringSchema,
    kind: z.enum(["image", "video"]),
    model: z.string().nullable().optional(),
    sizeBytes: z.number().int().nonnegative(),
    stagedStorageKey: z.string().nullable().optional(),
    storageKey: z.string().nullable().optional(),
    storageProvider: nonEmptyStringSchema,
  }),
]);

export type RuntimeCompletionSettlementJobPayload = {
  readonly providerCostCredits: number;
  readonly generatedAsset: RuntimeGeneratedPrimaryAssetPayload;
  readonly jobId: string;
  readonly ownerUserId: string;
  readonly reviewRequired: boolean;
  readonly taskId: string;
  readonly workflowId: string;
};

export const RuntimeCompletionSettlementJobPayloadSchema = z.object({
  providerCostCredits: z.number().int().nonnegative(),
  generatedAsset: RuntimeGeneratedPrimaryAssetPayloadSchema,
  jobId: jobIdSchema,
  ownerUserId: nonEmptyStringSchema,
  reviewRequired: z.boolean(),
  taskId: nonEmptyStringSchema,
  workflowId: nonEmptyStringSchema,
});

export type RuntimeFailureSettlementJobPayload = {
  readonly failureReason: Exclude<
    TaskFailureReason,
    { readonly type: "UPSTREAM_FAILED" }
  >;
  readonly failureSource: TaskSettlementFailureSource;
  readonly providerCostCredits?: number;
  readonly jobId: string;
  readonly ownerUserId: string;
  readonly taskId: string;
  readonly workflowId: string;
};

export const RuntimeFailureSettlementJobPayloadSchema: z.ZodType<RuntimeFailureSettlementJobPayload> =
  z.object({
    failureReason: z.discriminatedUnion("type", [
      z.object({ type: z.literal("INSUFFICIENT_CREDITS") }),
      z.object({ message: z.string(), type: z.literal("PROVIDER_FAILED") }),
      z.object({ message: z.string(), type: z.literal("EXECUTION_FAILED") }),
    ]),
    failureSource: z.discriminatedUnion("type", [
      z.object({
        taskDebitRefundable: z.boolean(),
        type: z.literal("PROVIDER"),
      }),
      z.object({
        taskDebitRefundable: z.literal(false),
        type: z.literal("POST_PROVIDER_INFRASTRUCTURE"),
      }),
    ]),
    providerCostCredits: z.number().int().nonnegative().optional(),
    jobId: jobIdSchema,
    ownerUserId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    workflowId: nonEmptyStringSchema,
  });

export type RuntimeJobDispatchError = {
  readonly _tag: "RuntimeJobDispatchError";
  readonly cause: unknown;
  readonly jobName: string;
  readonly message: string;
};

export type ParsedRuntimeJob =
  | {
      readonly data: RuntimeCompletionSettlementJobPayload;
      readonly name: typeof RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME;
    }
  | {
      readonly data: RuntimeExecutionJobPayload;
      readonly name: typeof RUNTIME_EXECUTION_JOB_NAME;
    }
  | {
      readonly data: RuntimeFailureSettlementJobPayload;
      readonly name: typeof RUNTIME_FAILURE_SETTLEMENT_JOB_NAME;
    }
  | {
      readonly data: RuntimeWakeUpJobPayload;
      readonly name: typeof RUNTIME_WAKE_UP_JOB_NAME;
    };

export function parseRuntimeJob(input: {
  readonly data: unknown;
  readonly name: string;
}):
  | { readonly job: ParsedRuntimeJob; readonly success: true }
  | {
      readonly error: RuntimeJobDispatchError;
      readonly success: false;
    } {
  switch (input.name) {
    case RUNTIME_EXECUTION_JOB_NAME: {
      const parsed = RuntimeExecutionJobPayloadSchema.safeParse(input.data);
      return parsed.success
        ? { job: { data: parsed.data, name: input.name }, success: true }
        : dispatchError(input.name, parsed.error);
    }
    case RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME: {
      const parsed = RuntimeCompletionSettlementJobPayloadSchema.safeParse(
        input.data,
      );
      return parsed.success
        ? { job: { data: parsed.data, name: input.name }, success: true }
        : dispatchError(input.name, parsed.error);
    }
    case RUNTIME_FAILURE_SETTLEMENT_JOB_NAME: {
      const parsed = RuntimeFailureSettlementJobPayloadSchema.safeParse(
        input.data,
      );
      return parsed.success
        ? { job: { data: parsed.data, name: input.name }, success: true }
        : dispatchError(input.name, parsed.error);
    }
    case RUNTIME_WAKE_UP_JOB_NAME: {
      const parsed = RuntimeWakeUpJobPayloadSchema.safeParse(input.data);
      return parsed.success
        ? { job: { data: parsed.data, name: input.name }, success: true }
        : dispatchError(input.name, parsed.error);
    }
    default:
      return dispatchError(
        input.name,
        new Error(`Unknown runtime job name: ${input.name}`),
      );
  }
}

function dispatchError(
  jobName: string,
  cause: unknown,
): {
  readonly error: RuntimeJobDispatchError;
  readonly success: false;
} {
  return {
    error: {
      _tag: "RuntimeJobDispatchError",
      cause,
      jobName,
      message:
        cause instanceof Error
          ? `RuntimeJobDispatchError: ${cause.message}`
          : `RuntimeJobDispatchError: invalid payload for ${jobName}.`,
    },
    success: false,
  };
}

export type BuildRuntimeExecutionJobPayloadInput = Omit<
  RuntimeExecutionJobPayload,
  "jobId"
>;

export function buildRuntimeExecutionJobPayload(
  input: BuildRuntimeExecutionJobPayloadInput,
): RuntimeExecutionJobPayload {
  return {
    ...input,
    jobId: buildExecutionJobId(input),
  };
}

export type BuildRuntimeCompletionSettlementJobPayloadInput = Omit<
  RuntimeCompletionSettlementJobPayload,
  "jobId"
>;

export function buildRuntimeCompletionSettlementJobPayload(
  input: BuildRuntimeCompletionSettlementJobPayloadInput,
): RuntimeCompletionSettlementJobPayload {
  return {
    ...input,
    jobId: buildOrchestratorEventId({
      kind: "completion",
      taskId: input.taskId,
    }),
  };
}

export type BuildRuntimeFailureSettlementJobPayloadInput = Omit<
  RuntimeFailureSettlementJobPayload,
  "jobId"
>;

export function buildRuntimeFailureSettlementJobPayload(
  input: BuildRuntimeFailureSettlementJobPayloadInput,
): RuntimeFailureSettlementJobPayload {
  return {
    jobId: buildOrchestratorEventId({
      kind: "failure",
      taskId: input.taskId,
    }),
    ...(input.providerCostCredits === undefined
      ? {
          failureReason: input.failureReason,
          failureSource: input.failureSource,
          ownerUserId: input.ownerUserId,
          taskId: input.taskId,
          workflowId: input.workflowId,
        }
      : input),
  };
}

export type BuildRuntimeWakeUpJobPayloadInput = Omit<
  RuntimeWakeUpJobPayload,
  "jobId"
>;

export type WorkflowQueueLike = {
  readonly add: (
    name: string,
    payload:
      | RuntimeCompletionSettlementJobPayload
      | RuntimeExecutionJobPayload
      | RuntimeFailureSettlementJobPayload
      | RuntimeWakeUpJobPayload,
    options: { readonly jobId: string },
  ) => Promise<unknown>;
};

export type WorkflowQueuePublishError = {
  readonly _tag: "WorkflowQueuePublishError";
  readonly cause: unknown;
  readonly jobId: string;
  readonly jobName: string;
  readonly taskId?: string;
  readonly workflowId: string;
};

export type WorkflowQueueInvalidJobIdError = {
  readonly _tag: "WorkflowQueueInvalidJobIdError";
  readonly jobId: string;
  readonly jobName: string;
  readonly message: string;
};

export type WorkflowQueueError =
  | WorkflowQueueInvalidJobIdError
  | WorkflowQueuePublishError;

export function buildRuntimeWakeUpJobPayload(
  input: BuildRuntimeWakeUpJobPayloadInput,
): RuntimeWakeUpJobPayload {
  return {
    ...input,
    jobId: buildWakeUpJobId(input),
  };
}

export function createWorkflowQueueAdapter(queue: WorkflowQueueLike) {
  const enqueueOne = (
    jobName: string,
    job:
      | RuntimeCompletionSettlementJobPayload
      | RuntimeExecutionJobPayload
      | RuntimeFailureSettlementJobPayload
      | RuntimeWakeUpJobPayload,
  ): Effect.Effect<void, WorkflowQueueError> => {
    if (job.jobId.includes(":")) {
      return Effect.fail({
        _tag: "WorkflowQueueInvalidJobIdError",
        jobId: job.jobId,
        jobName,
        message: "Workflow BullMQ job ids must not contain colons.",
      } satisfies WorkflowQueueInvalidJobIdError);
    }

    return Effect.tryPromise({
      try: () => queue.add(jobName, job, { jobId: job.jobId }),
      catch: (cause): WorkflowQueuePublishError => ({
        _tag: "WorkflowQueuePublishError",
        cause,
        jobId: job.jobId,
        jobName,
        taskId: "taskId" in job ? job.taskId : job.parentTaskId,
        workflowId: job.workflowId,
      }),
    }).pipe(
      Effect.asVoid,
      Effect.tapError((error) =>
        Effect.logWarning("Runtime queue publish failed", {
          jobId: error.jobId,
          jobName: error.jobName,
          taskId: error.taskId,
          workflowId: error.workflowId,
        }),
      ),
      Effect.withSpan("runtime.queue.enqueue", {
        attributes: {
          "workflow_runtime.job_id": job.jobId,
          "workflow_runtime.job_name": jobName,
          "workflow_runtime.workflow_id": job.workflowId,
        },
      }),
    );
  };

  return {
    enqueueExecutionJob(job: RuntimeExecutionJobPayload) {
      return enqueueOne(RUNTIME_EXECUTION_JOB_NAME, job);
    },

    enqueueWakeUpJob(job: RuntimeWakeUpJobPayload) {
      return enqueueOne(RUNTIME_WAKE_UP_JOB_NAME, job);
    },

    enqueueCompletionSettlement(job: RuntimeCompletionSettlementJobPayload) {
      return enqueueOne(RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME, job);
    },

    enqueueFailureSettlement(job: RuntimeFailureSettlementJobPayload) {
      return enqueueOne(RUNTIME_FAILURE_SETTLEMENT_JOB_NAME, job);
    },
  };
}
