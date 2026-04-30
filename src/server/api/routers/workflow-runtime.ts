import { TRPCError } from "@trpc/server";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { createRedisSubscriber } from "~/server/redis";
import {
  assertWorkflowProjectAccess,
  getWorkflowProject,
} from "~/server/workflow/projects";
import {
  parseTaskStatusEventPayload,
  workflowEventChannel,
} from "~/server/workflow-runtime/task-status-event-stream";
import { createWorkflowRuntimeComposition } from "~/server/workflow-runtime/workflow-runtime-composition";
import type { WorkflowRuntimeOrchestratorError } from "~/server/workflow-runtime/workflow-runtime-orchestrator";
import { getPlanningStateForWorkflow } from "~/server/workflow-runtime/workflow-runtime-planning-state-repository";
import { getTaskRunProjectionForWorkflow } from "~/server/workflow-runtime/workflow-runtime-task-projection-repository";

type QueryRow = Record<string, unknown>;

const estimatedCreditCostByNodeIdSchema = z.record(
  z.string().min(1),
  z.number().int().nonnegative(),
);

const runNodeInputSchema = z.object({
  estimatedCreditCostByNodeId: estimatedCreditCostByNodeIdSchema.optional(),
  nodeId: z.string().min(1),
  projectId: z.string().min(1),
});

const taskRunDecisionInputSchema = z.object({
  attempt: z.number().int().nonnegative(),
  projectId: z.string().min(1),
  taskRunId: z.string().min(1),
});

const taskEventsInputSchema = z.object({
  projectId: z.string().min(1),
});

export const workflowRuntimeRouter = createTRPCRouter({
  runTarget: protectedProcedure
    .input(runNodeInputSchema)
    .mutation(async ({ ctx, input }) => {
      const ownerUserId = ctx.session.user.id;
      const project = await getWorkflowProject({
        ownerUserId,
        projectId: input.projectId,
      }).catch(throwTRPCError);
      const planningState = await getPlanningStateForWorkflow(db, {
        ownerUserId,
        workflowId: project.id,
      }).catch(throwTRPCError);
      const { orchestrator } =
        await createWorkflowRuntimeComposition().catch(throwTRPCError);

      const result = await orchestrator.startWorkflowRun({
        ...planningState,
        command: { targetNodeIds: [input.nodeId], type: "run-target" },
        document: project.document,
        estimatedCreditCostByNodeId: input.estimatedCreditCostByNodeId,
        ownerId: ownerUserId,
        workflowId: project.id,
      });

      return unwrapOrchestratorResult(result);
    }),

  rerunNode: protectedProcedure
    .input(runNodeInputSchema)
    .mutation(async ({ ctx, input }) => {
      const ownerUserId = ctx.session.user.id;
      const project = await getWorkflowProject({
        ownerUserId,
        projectId: input.projectId,
      }).catch(throwTRPCError);
      const planningState = await getPlanningStateForWorkflow(db, {
        ownerUserId,
        workflowId: project.id,
      }).catch(throwTRPCError);
      const { orchestrator } =
        await createWorkflowRuntimeComposition().catch(throwTRPCError);

      const result = await orchestrator.startWorkflowRun({
        ...planningState,
        command: { nodeId: input.nodeId, type: "rerun-node" },
        document: project.document,
        estimatedCreditCostByNodeId: input.estimatedCreditCostByNodeId,
        ownerId: ownerUserId,
        workflowId: project.id,
      });

      return unwrapOrchestratorResult(result);
    }),

  approveTaskRun: protectedProcedure
    .input(taskRunDecisionInputSchema)
    .mutation(async ({ ctx, input }) =>
      decideTaskRun(ctx.session.user.id, input, "approve"),
    ),

  rejectTaskRun: protectedProcedure
    .input(taskRunDecisionInputSchema)
    .mutation(async ({ ctx, input }) =>
      decideTaskRun(ctx.session.user.id, input, "reject"),
    ),

  cancelTaskRun: protectedProcedure
    .input(taskRunDecisionInputSchema)
    .mutation(async ({ ctx, input }) =>
      decideTaskRun(ctx.session.user.id, input, "cancel"),
    ),

  taskEvents: protectedProcedure
    .input(taskEventsInputSchema)
    .subscription(async function* ({ ctx, input, signal }) {
      await assertWorkflowProjectAccess({
        ownerUserId: ctx.session.user.id,
        projectId: input.projectId,
      }).catch(throwTRPCError);

      const subscriber = await createRedisSubscriber().catch(throwTRPCError);
      const events: string[] = [];
      let resolveNextEvent: (() => void) | undefined;
      const channel = workflowEventChannel(input.projectId);

      const onEvent = (payload: string) => {
        events.push(payload);
        resolveNextEvent?.();
      };

      await subscriber.subscribe(channel, onEvent).catch(throwTRPCError);

      try {
        while (!signal?.aborted) {
          const payload = events.shift();
          if (payload) {
            yield parseTaskStatusEventPayload(payload);
            continue;
          }

          await new Promise<void>((resolve) => {
            const abortHandler = () => {
              signal?.removeEventListener("abort", abortHandler);
              resolveNextEvent = undefined;
              resolve();
            };

            resolveNextEvent = () => {
              signal?.removeEventListener("abort", abortHandler);
              resolveNextEvent = undefined;
              resolve();
            };

            signal?.addEventListener("abort", abortHandler, { once: true });
          });
        }
      } finally {
        await subscriber.unsubscribe(channel, onEvent).catch(() => undefined);
        await subscriber.quit().catch(() => undefined);
      }
    }),

  taskProjection: protectedProcedure
    .input(taskEventsInputSchema)
    .query(async ({ ctx, input }) => {
      const ownerUserId = ctx.session.user.id;
      await assertWorkflowProjectAccess({
        ownerUserId,
        projectId: input.projectId,
      }).catch(throwTRPCError);

      return getTaskRunProjectionForWorkflow(db, {
        ownerUserId,
        workflowId: input.projectId,
      }).catch(throwTRPCError);
    }),
});

async function decideTaskRun(
  ownerUserId: string,
  input: z.infer<typeof taskRunDecisionInputSchema>,
  decision: "approve" | "cancel" | "reject",
) {
  await assertWorkflowProjectAccess({
    ownerUserId,
    projectId: input.projectId,
  }).catch(throwTRPCError);
  await assertTaskRunBelongsToProject(db, {
    attempt: input.attempt,
    ownerUserId,
    taskRunId: input.taskRunId,
    workflowId: input.projectId,
  }).catch(throwTRPCError);

  const { orchestrator } =
    await createWorkflowRuntimeComposition().catch(throwTRPCError);
  const command = {
    attempt: input.attempt,
    ownerUserId,
    taskRunId: input.taskRunId,
    workflowId: input.projectId,
  };

  if (decision === "approve") {
    return unwrapOrchestratorResult(await orchestrator.approveTaskRun(command));
  }

  if (decision === "cancel") {
    return unwrapOrchestratorResult(await orchestrator.cancelTaskRun(command));
  }

  return unwrapOrchestratorResult(await orchestrator.rejectTaskRun(command));
}

async function assertTaskRunBelongsToProject(
  dbLike: { readonly execute: (query: SQL) => Promise<unknown> },
  input: {
    readonly attempt: number;
    readonly ownerUserId: string;
    readonly taskRunId: string;
    readonly workflowId: string;
  },
) {
  const rows = rowsFromResult(
    await dbLike.execute(sql`
      select id
      from task_runs
      where id = ${input.taskRunId}
        and owner_user_id = ${input.ownerUserId}
        and workflow_id = ${input.workflowId}
        and attempt = ${input.attempt}
      limit 1
    `),
  );

  if (!rows[0]) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Task Run was not found for this workflow.",
    });
  }
}

function unwrapOrchestratorResult<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | {
        readonly error: WorkflowRuntimeOrchestratorError;
        readonly ok: false;
      },
) {
  if (result.ok) {
    return result.value;
  }

  throw orchestratorErrorToTRPCError(result.error);
}

function orchestratorErrorToTRPCError(error: WorkflowRuntimeOrchestratorError) {
  if (error._tag === "WorkflowRunPlannerError") {
    return new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }

  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    cause: error.cause,
    message: error.message,
  });
}

function throwTRPCError(error: unknown): never {
  if (error instanceof TRPCError) {
    throw error;
  }

  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    cause: error,
    message:
      error instanceof Error ? error.message : "Workflow runtime failed.",
  });
}

function rowsFromResult(result: unknown): readonly QueryRow[] {
  if (Array.isArray(result)) {
    return result.filter(isQueryRow);
  }

  if (isQueryRow(result) && Array.isArray(result.rows)) {
    return result.rows.filter(isQueryRow);
  }

  return [];
}

function isQueryRow(value: unknown): value is QueryRow {
  return typeof value === "object" && value !== null;
}
