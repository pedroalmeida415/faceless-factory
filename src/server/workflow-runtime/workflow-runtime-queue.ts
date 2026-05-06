import { Effect } from "effect";
import { z } from "zod";
import type {
  TaskRunFailureReason,
  TaskRunSettlementFailureSource,
} from "~/lib/workflow-runtime/domain/task-run-state";
import {
  buildExecutionJobId,
  buildOrchestratorEventId,
  buildWakeUpJobId,
} from "~/lib/workflow-runtime/runtime/task-status-events";

export const WORKFLOW_RUNTIME_EXECUTION_JOB_NAME = "execute-task-run";
export const WORKFLOW_RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME =
  "settle-task-run-completion";
export const WORKFLOW_RUNTIME_FAILURE_SETTLEMENT_JOB_NAME =
  "settle-task-run-failure";
export const WORKFLOW_RUNTIME_WAKE_UP_JOB_NAME = "wake-up-task-run-children";

const jobIdSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes(":"), {
    message: "BullMQ job ids must not contain colons.",
  });
const nonEmptyStringSchema = z.string().min(1);
const attemptSchema = z.number().int().nonnegative();
const itemIndexSchema = z.number().int().nonnegative();

export type WorkflowRuntimeExecutionJobPayload = {
  readonly attempt: number;
  readonly itemIndex: number;
  readonly jobId: string;
  readonly nodeExecutionId: string;
  readonly ownerUserId: string;
  readonly taskRunId: string;
  readonly workflowId: string;
};

export const WorkflowRuntimeExecutionJobPayloadSchema = z.object({
  attempt: attemptSchema,
  itemIndex: itemIndexSchema,
  jobId: jobIdSchema,
  nodeExecutionId: nonEmptyStringSchema,
  ownerUserId: nonEmptyStringSchema,
  taskRunId: nonEmptyStringSchema,
  workflowId: nonEmptyStringSchema,
});

export type WorkflowRuntimeWakeUpJobPayload = {
  readonly jobId: string;
  readonly ownerUserId: string;
  readonly parentTaskRunId: string;
  readonly workflowId: string;
};

export const WorkflowRuntimeWakeUpJobPayloadSchema = z.object({
  jobId: jobIdSchema,
  ownerUserId: nonEmptyStringSchema,
  parentTaskRunId: nonEmptyStringSchema,
  workflowId: nonEmptyStringSchema,
});

type WorkflowRuntimeGeneratedPrimaryAssetPayloadBase = {
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

export type WorkflowRuntimeGeneratedPrimaryAssetPayload =
  | (WorkflowRuntimeGeneratedPrimaryAssetPayloadBase & {
      readonly kind: "text";
      readonly text: string;
    })
  | (WorkflowRuntimeGeneratedPrimaryAssetPayloadBase & {
      readonly cdnUrl: string;
      readonly kind: "image" | "video";
    });

const WorkflowRuntimeGeneratedPrimaryAssetPayloadSchema = z.discriminatedUnion(
  "kind",
  [
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
  ],
);

export type WorkflowRuntimeCompletionSettlementJobPayload = {
  readonly attempt: number;
  readonly providerCostCredits: number;
  readonly generatedAsset: WorkflowRuntimeGeneratedPrimaryAssetPayload;
  readonly jobId: string;
  readonly ownerUserId: string;
  readonly reviewRequired: boolean;
  readonly taskRunId: string;
  readonly workflowId: string;
};

export const WorkflowRuntimeCompletionSettlementJobPayloadSchema = z.object({
  attempt: attemptSchema,
  providerCostCredits: z.number().int().nonnegative(),
  generatedAsset: WorkflowRuntimeGeneratedPrimaryAssetPayloadSchema,
  jobId: jobIdSchema,
  ownerUserId: nonEmptyStringSchema,
  reviewRequired: z.boolean(),
  taskRunId: nonEmptyStringSchema,
  workflowId: nonEmptyStringSchema,
});

export type WorkflowRuntimeFailureSettlementJobPayload = {
  readonly attempt: number;
  readonly failureReason: Exclude<
    TaskRunFailureReason,
    { readonly type: "UPSTREAM_FAILED" }
  >;
  readonly failureSource: TaskRunSettlementFailureSource;
  readonly providerCostCredits?: number;
  readonly jobId: string;
  readonly ownerUserId: string;
  readonly taskRunId: string;
  readonly workflowId: string;
};

export const WorkflowRuntimeFailureSettlementJobPayloadSchema: z.ZodType<WorkflowRuntimeFailureSettlementJobPayload> =
  z.object({
    attempt: attemptSchema,
    failureReason: z.discriminatedUnion("type", [
      z.object({ type: z.literal("INSUFFICIENT_CREDITS") }),
      z.object({ message: z.string(), type: z.literal("PROVIDER_FAILED") }),
      z.object({ message: z.string(), type: z.literal("EXECUTION_FAILED") }),
    ]),
    failureSource: z.discriminatedUnion("type", [
      z.object({
        taskRunDebitRefundable: z.boolean(),
        type: z.literal("PROVIDER"),
      }),
      z.object({
        taskRunDebitRefundable: z.literal(false),
        type: z.literal("POST_PROVIDER_INFRASTRUCTURE"),
      }),
    ]),
    providerCostCredits: z.number().int().nonnegative().optional(),
    jobId: jobIdSchema,
    ownerUserId: nonEmptyStringSchema,
    taskRunId: nonEmptyStringSchema,
    workflowId: nonEmptyStringSchema,
  });

export type WorkflowRuntimeJobDispatchError = {
  readonly _tag: "WorkflowRuntimeJobDispatchError";
  readonly cause: unknown;
  readonly jobName: string;
  readonly message: string;
};

export type ParsedWorkflowRuntimeJob =
  | {
      readonly data: WorkflowRuntimeCompletionSettlementJobPayload;
      readonly name: typeof WORKFLOW_RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME;
    }
  | {
      readonly data: WorkflowRuntimeExecutionJobPayload;
      readonly name: typeof WORKFLOW_RUNTIME_EXECUTION_JOB_NAME;
    }
  | {
      readonly data: WorkflowRuntimeFailureSettlementJobPayload;
      readonly name: typeof WORKFLOW_RUNTIME_FAILURE_SETTLEMENT_JOB_NAME;
    }
  | {
      readonly data: WorkflowRuntimeWakeUpJobPayload;
      readonly name: typeof WORKFLOW_RUNTIME_WAKE_UP_JOB_NAME;
    };

export function parseWorkflowRuntimeJob(input: {
  readonly data: unknown;
  readonly name: string;
}):
  | { readonly job: ParsedWorkflowRuntimeJob; readonly success: true }
  | {
      readonly error: WorkflowRuntimeJobDispatchError;
      readonly success: false;
    } {
  switch (input.name) {
    case WORKFLOW_RUNTIME_EXECUTION_JOB_NAME: {
      const parsed = WorkflowRuntimeExecutionJobPayloadSchema.safeParse(
        input.data,
      );
      return parsed.success
        ? { job: { data: parsed.data, name: input.name }, success: true }
        : dispatchError(input.name, parsed.error);
    }
    case WORKFLOW_RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME: {
      const parsed =
        WorkflowRuntimeCompletionSettlementJobPayloadSchema.safeParse(
          input.data,
        );
      return parsed.success
        ? { job: { data: parsed.data, name: input.name }, success: true }
        : dispatchError(input.name, parsed.error);
    }
    case WORKFLOW_RUNTIME_FAILURE_SETTLEMENT_JOB_NAME: {
      const parsed = WorkflowRuntimeFailureSettlementJobPayloadSchema.safeParse(
        input.data,
      );
      return parsed.success
        ? { job: { data: parsed.data, name: input.name }, success: true }
        : dispatchError(input.name, parsed.error);
    }
    case WORKFLOW_RUNTIME_WAKE_UP_JOB_NAME: {
      const parsed = WorkflowRuntimeWakeUpJobPayloadSchema.safeParse(
        input.data,
      );
      return parsed.success
        ? { job: { data: parsed.data, name: input.name }, success: true }
        : dispatchError(input.name, parsed.error);
    }
    default:
      return dispatchError(
        input.name,
        new Error(`Unknown workflow runtime job name: ${input.name}`),
      );
  }
}

function dispatchError(
  jobName: string,
  cause: unknown,
): {
  readonly error: WorkflowRuntimeJobDispatchError;
  readonly success: false;
} {
  return {
    error: {
      _tag: "WorkflowRuntimeJobDispatchError",
      cause,
      jobName,
      message:
        cause instanceof Error
          ? `WorkflowRuntimeJobDispatchError: ${cause.message}`
          : `WorkflowRuntimeJobDispatchError: invalid payload for ${jobName}.`,
    },
    success: false,
  };
}

export type BuildWorkflowRuntimeExecutionJobPayloadInput = Omit<
  WorkflowRuntimeExecutionJobPayload,
  "jobId"
>;

export function buildWorkflowRuntimeExecutionJobPayload(
  input: BuildWorkflowRuntimeExecutionJobPayloadInput,
): WorkflowRuntimeExecutionJobPayload {
  return {
    ...input,
    jobId: buildExecutionJobId(input),
  };
}

export type BuildWorkflowRuntimeCompletionSettlementJobPayloadInput = Omit<
  WorkflowRuntimeCompletionSettlementJobPayload,
  "jobId"
>;

export function buildWorkflowRuntimeCompletionSettlementJobPayload(
  input: BuildWorkflowRuntimeCompletionSettlementJobPayloadInput,
): WorkflowRuntimeCompletionSettlementJobPayload {
  return {
    ...input,
    jobId: buildOrchestratorEventId({
      attempt: input.attempt,
      kind: "completion",
      taskRunId: input.taskRunId,
    }),
  };
}

export type BuildWorkflowRuntimeFailureSettlementJobPayloadInput = Omit<
  WorkflowRuntimeFailureSettlementJobPayload,
  "jobId"
>;

export function buildWorkflowRuntimeFailureSettlementJobPayload(
  input: BuildWorkflowRuntimeFailureSettlementJobPayloadInput,
): WorkflowRuntimeFailureSettlementJobPayload {
  return {
    jobId: buildOrchestratorEventId({
      attempt: input.attempt,
      kind: "failure",
      taskRunId: input.taskRunId,
    }),
    ...(input.providerCostCredits === undefined
      ? {
          attempt: input.attempt,
          failureReason: input.failureReason,
          failureSource: input.failureSource,
          ownerUserId: input.ownerUserId,
          taskRunId: input.taskRunId,
          workflowId: input.workflowId,
        }
      : input),
  };
}

export type BuildWorkflowRuntimeWakeUpJobPayloadInput = Omit<
  WorkflowRuntimeWakeUpJobPayload,
  "jobId"
>;

export type WorkflowRuntimeQueueLike = {
  readonly add: (
    name: string,
    payload:
      | WorkflowRuntimeCompletionSettlementJobPayload
      | WorkflowRuntimeExecutionJobPayload
      | WorkflowRuntimeFailureSettlementJobPayload
      | WorkflowRuntimeWakeUpJobPayload,
    options: { readonly jobId: string },
  ) => Promise<unknown>;
};

export type WorkflowRuntimeQueuePublishError = {
  readonly _tag: "WorkflowRuntimeQueuePublishError";
  readonly cause: unknown;
  readonly jobId: string;
  readonly jobName: string;
  readonly taskRunId?: string;
  readonly workflowId: string;
};

export type WorkflowRuntimeQueueInvalidJobIdError = {
  readonly _tag: "WorkflowRuntimeQueueInvalidJobIdError";
  readonly jobId: string;
  readonly jobName: string;
  readonly message: string;
};

export type WorkflowRuntimeQueueError =
  | WorkflowRuntimeQueueInvalidJobIdError
  | WorkflowRuntimeQueuePublishError;

export function buildWorkflowRuntimeWakeUpJobPayload(
  input: BuildWorkflowRuntimeWakeUpJobPayloadInput,
): WorkflowRuntimeWakeUpJobPayload {
  return {
    ...input,
    jobId: buildWakeUpJobId(input),
  };
}

export function createWorkflowRuntimeQueueAdapter(
  queue: WorkflowRuntimeQueueLike,
) {
  const enqueueOne = (
    jobName: string,
    job:
      | WorkflowRuntimeCompletionSettlementJobPayload
      | WorkflowRuntimeExecutionJobPayload
      | WorkflowRuntimeFailureSettlementJobPayload
      | WorkflowRuntimeWakeUpJobPayload,
  ): Effect.Effect<void, WorkflowRuntimeQueueError> => {
    if (job.jobId.includes(":")) {
      return Effect.fail({
        _tag: "WorkflowRuntimeQueueInvalidJobIdError",
        jobId: job.jobId,
        jobName,
        message: "Workflow Runtime BullMQ job ids must not contain colons.",
      } satisfies WorkflowRuntimeQueueInvalidJobIdError);
    }

    return Effect.tryPromise({
      try: () => queue.add(jobName, job, { jobId: job.jobId }),
      catch: (cause): WorkflowRuntimeQueuePublishError => ({
        _tag: "WorkflowRuntimeQueuePublishError",
        cause,
        jobId: job.jobId,
        jobName,
        taskRunId: "taskRunId" in job ? job.taskRunId : job.parentTaskRunId,
        workflowId: job.workflowId,
      }),
    }).pipe(
      Effect.asVoid,
      Effect.tapError((error) =>
        Effect.logWarning("Workflow Runtime queue publish failed", {
          jobId: error.jobId,
          jobName: error.jobName,
          taskRunId: error.taskRunId,
          workflowId: error.workflowId,
        }),
      ),
      Effect.withSpan("workflow-runtime.queue.enqueue", {
        attributes: {
          "workflow_runtime.job_id": job.jobId,
          "workflow_runtime.job_name": jobName,
          "workflow_runtime.workflow_id": job.workflowId,
        },
      }),
    );
  };

  return {
    enqueueExecutionJob(job: WorkflowRuntimeExecutionJobPayload) {
      return enqueueOne(WORKFLOW_RUNTIME_EXECUTION_JOB_NAME, job);
    },

    enqueueWakeUpJob(job: WorkflowRuntimeWakeUpJobPayload) {
      return enqueueOne(WORKFLOW_RUNTIME_WAKE_UP_JOB_NAME, job);
    },

    async enqueueExecutionJobs(
      jobs: readonly WorkflowRuntimeExecutionJobPayload[],
    ): Promise<void> {
      for (const job of jobs) {
        await Effect.runPromise(
          enqueueOne(WORKFLOW_RUNTIME_EXECUTION_JOB_NAME, job),
        );
      }
    },

    async enqueueCompletionSettlement(
      job: WorkflowRuntimeCompletionSettlementJobPayload,
    ): Promise<void> {
      await queue.add(WORKFLOW_RUNTIME_COMPLETION_SETTLEMENT_JOB_NAME, job, {
        jobId: job.jobId,
      });
    },

    async enqueueFailureSettlement(
      job: WorkflowRuntimeFailureSettlementJobPayload,
    ): Promise<void> {
      await queue.add(WORKFLOW_RUNTIME_FAILURE_SETTLEMENT_JOB_NAME, job, {
        jobId: job.jobId,
      });
    },

    async enqueueWakeUpJobs(
      jobs: readonly WorkflowRuntimeWakeUpJobPayload[],
    ): Promise<void> {
      for (const job of jobs) {
        await Effect.runPromise(
          enqueueOne(WORKFLOW_RUNTIME_WAKE_UP_JOB_NAME, job),
        );
      }
    },
  };
}
