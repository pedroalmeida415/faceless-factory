import { TRPCError } from "@trpc/server";
import { type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import { planWorkflowRun } from "~/features/runtime/planning/workflow-run-planner";
import {
  type RuntimeCommandOutcome,
  toRuntimeTransportOutcome,
} from "~/features/runtime/server/command-outcome";
import {
  type RuntimeCommandError,
  RuntimeCommands,
  type RuntimeCommandsService,
} from "~/features/runtime/server/commands";
import { getPlanningStateForWorkflow } from "~/features/runtime/server/planning-state-repository";
import { getTaskRunProjectionForWorkflow } from "~/features/runtime/server/task-projection-repository";
import {
  parseTaskStatusEventPayloadEffect,
  workflowEventChannel,
} from "~/features/runtime/server/task-status-event-stream";
import { buildExecutionCostProjection } from "~/features/workflow/server/pricing-catalog";
import {
  assertWorkflowProjectAccess,
  getWorkflowProject,
} from "~/features/workflow/server/projects";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { ServerRuntime } from "~/server/effect";
import { createRedisSubscriber } from "~/server/redis";
import { DatabaseServiceLive, db } from "~/server/services/database";

type QueryRow = Record<string, unknown>;

const runTaskSlotTargetSchema = z.object({
  itemIndex: z.number().int().nonnegative(),
  nodeExecutionId: z.string().min(1),
  type: z.literal("task-slot"),
});

const runInputSchema = z.object({
  projectId: z.string().min(1),
  target: z.discriminatedUnion("type", [
    z.object({ nodeId: z.string().min(1), type: z.literal("node") }),
    runTaskSlotTargetSchema,
  ]),
});

const taskRunDecisionInputSchema = z.object({
  attempt: z.number().int().nonnegative(),
  projectId: z.string().min(1),
  taskRunId: z.string().min(1),
});

const taskEventsInputSchema = z.object({
  projectId: z.string().min(1),
});

export const runtimeRouter = createTRPCRouter({
  executionCostProjection: protectedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const project = await getWorkflowProject({
        ownerUserId: ctx.session.user.id,
        projectId: input.projectId,
      }).catch(throwTRPCError);

      return buildExecutionCostProjection(project.document);
    }),

  runCostPreview: protectedProcedure
    .input(runInputSchema)
    .query(async ({ ctx, input }) => {
      const ownerUserId = ctx.session.user.id;
      const project = await getWorkflowProject({
        ownerUserId,
        projectId: input.projectId,
      }).catch(throwTRPCError);
      const planningState = await Effect.runPromise(
        getPlanningStateForWorkflow({
          ownerUserId,
          workflowId: project.id,
        }).pipe(Effect.provide(DatabaseServiceLive)),
      ).catch(throwTRPCError);
      const planning = planWorkflowRun({
        ...planningState,
        command:
          input.target.type === "node"
            ? { nodeId: input.target.nodeId, type: "run-node" }
            : {
                itemIndex: input.target.itemIndex,
                nodeExecutionId: input.target.nodeExecutionId,
                type: "run-task-slot",
              },
        document: project.document,
        ownerId: ownerUserId,
        workflowId: project.id,
      });
      if (!planning.ok) {
        throw commandErrorToTRPCError({
          ...planning.error,
          committed: false,
        });
      }

      const currentCreditBalance = await getCurrentCreditBalance(ownerUserId);

      return {
        ...planning.value.runCostPreview,
        balance: {
          available: currentCreditBalance,
          enoughForImmediateQueue:
            currentCreditBalance >=
            planning.value.runCostPreview.immediateDebitTotal,
        },
      };
    }),

  run: protectedProcedure
    .input(runInputSchema)
    .mutation(async ({ ctx, input }) => {
      const ownerUserId = ctx.session.user.id;
      const project = await getWorkflowProject({
        ownerUserId,
        projectId: input.projectId,
      }).catch(throwTRPCError);
      const planningState = await Effect.runPromise(
        getPlanningStateForWorkflow({
          ownerUserId,
          workflowId: project.id,
        }).pipe(Effect.provide(DatabaseServiceLive)),
      ).catch(throwTRPCError);
      const result = await runRuntimeCommand((commands) =>
        commands.startWorkflowRun({
          ...planningState,
          command:
            input.target.type === "node"
              ? { nodeId: input.target.nodeId, type: "run-node" }
              : {
                  itemIndex: input.target.itemIndex,
                  nodeExecutionId: input.target.nodeExecutionId,
                  type: "run-task-slot",
                },
          document: project.document,
          ownerId: ownerUserId,
          workflowId: project.id,
        }),
      );

      return unwrapRuntimeOutcome(result);
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
            yield await Effect.runPromise(
              parseTaskStatusEventPayloadEffect(payload),
            ).catch(throwTRPCError);
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

      return Effect.runPromise(
        getTaskRunProjectionForWorkflow({
          ownerUserId,
          workflowId: input.projectId,
        }).pipe(Effect.provide(DatabaseServiceLive)),
      ).catch(throwTRPCError);
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

  const command = {
    attempt: input.attempt,
    ownerUserId,
    taskRunId: input.taskRunId,
    workflowId: input.projectId,
  };

  if (decision === "approve") {
    return unwrapRuntimeOutcome(
      await runRuntimeCommand((commands) => commands.approveTaskRun(command)),
    );
  }

  if (decision === "cancel") {
    return unwrapRuntimeOutcome(
      await runRuntimeCommand((commands) => commands.cancelTaskRun(command)),
    );
  }

  return unwrapRuntimeOutcome(
    await runRuntimeCommand((commands) => commands.rejectTaskRun(command)),
  );
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

async function runRuntimeCommand<T>(
  build: (
    commands: RuntimeCommandsService,
  ) => Effect.Effect<RuntimeCommandOutcome<T>, RuntimeCommandError>,
) {
  return ServerRuntime.runPromise(Effect.flatMap(RuntimeCommands, build)).catch(
    (error: unknown) => {
      throw commandErrorToTRPCError(toCommandError(error));
    },
  );
}

function unwrapRuntimeOutcome<T>(outcome: RuntimeCommandOutcome<T>) {
  return toRuntimeTransportOutcome(outcome);
}

function commandErrorToTRPCError(error: RuntimeCommandError) {
  if (error._tag === "WorkflowRunPlannerError") {
    return new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }

  if (error._tag === "TaskRunCancellationBlockedError") {
    return new TRPCError({
      code: "BAD_REQUEST",
      message: error.message,
    });
  }

  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "message" in error ? error.message : "Workflow runtime failed.",
  });
}

function toCommandError(error: unknown): RuntimeCommandError {
  if (isCommandError(error)) {
    return error;
  }

  return {
    _tag: "RuntimeCommitError",
    cause: error,
    committed: false,
    message: "Workflow runtime failed.",
  };
}

function isCommandError(error: unknown): error is RuntimeCommandError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
  );
}

async function getCurrentCreditBalance(ownerUserId: string) {
  const rows = rowsFromResult(
    await db.execute(sql`
      select credit_balance as "creditBalance"
      from "user"
      where id = ${ownerUserId}
      limit 1
    `),
  );
  const balance = rows[0]?.creditBalance;
  if (typeof balance === "number") {
    return balance;
  }
  if (typeof balance === "string" && /^-?\d+$/.test(balance)) {
    return Number(balance);
  }

  throw new TRPCError({ code: "NOT_FOUND", message: "User was not found." });
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
