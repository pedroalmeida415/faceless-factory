import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
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
import { getTaskProjectionForWorkflow } from "~/features/runtime/server/task-projection-repository";
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
import { tasks, user } from "~/server/database/schema";
import { ServerRuntime } from "~/server/effect";
import { createRedisSubscriber } from "~/server/redis";
import { DatabaseService } from "~/server/services/database";

const runTaskTargetSchema = z.object({
  branchIndex: z.number().int().nonnegative(),
  nodeRunId: z.string().min(1),
  type: z.literal("task"),
});

const runInputSchema = z.object({
  projectId: z.string().min(1),
  target: z.discriminatedUnion("type", [
    z.object({ nodeId: z.string().min(1), type: z.literal("node") }),
    runTaskTargetSchema,
  ]),
});

const taskDecisionInputSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
});

const taskEventsInputSchema = z.object({
  projectId: z.string().min(1),
});

export const runtimeRouter = createTRPCRouter({
  executionCostProjection: protectedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const project = await ServerRuntime.runPromise(
        getWorkflowProject({
          ownerUserId: ctx.session.user.id,
          projectId: input.projectId,
        }),
      ).catch(throwTRPCError);

      return buildExecutionCostProjection(project.document);
    }),

  runCostPreview: protectedProcedure
    .input(runInputSchema)
    .query(async ({ ctx, input }) => {
      const ownerUserId = ctx.session.user.id;
      const project = await ServerRuntime.runPromise(
        getWorkflowProject({
          ownerUserId,
          projectId: input.projectId,
        }),
      ).catch(throwTRPCError);
      const planningState = await ServerRuntime.runPromise(
        getPlanningStateForWorkflow({
          ownerUserId,
          workflowId: project.id,
        }),
      ).catch(throwTRPCError);
      const planning = planWorkflowRun({
        ...planningState,
        command:
          input.target.type === "node"
            ? { nodeId: input.target.nodeId, type: "run-node" }
            : {
                branchIndex: input.target.branchIndex,
                nodeRunId: input.target.nodeRunId,
                type: "run-task",
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

      const currentCreditBalance = await ServerRuntime.runPromise(
        getCurrentCreditBalance(ownerUserId),
      ).catch(throwTRPCError);

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
      const project = await ServerRuntime.runPromise(
        getWorkflowProject({
          ownerUserId,
          projectId: input.projectId,
        }),
      ).catch(throwTRPCError);
      const planningState = await ServerRuntime.runPromise(
        getPlanningStateForWorkflow({
          ownerUserId,
          workflowId: project.id,
        }),
      ).catch(throwTRPCError);
      const result = await runRuntimeCommand((commands) =>
        commands.startWorkflowRun({
          ...planningState,
          command:
            input.target.type === "node"
              ? { nodeId: input.target.nodeId, type: "run-node" }
              : {
                  branchIndex: input.target.branchIndex,
                  nodeRunId: input.target.nodeRunId,
                  type: "run-task",
                },
          document: project.document,
          ownerId: ownerUserId,
          workflowId: project.id,
        }),
      );

      return unwrapRuntimeOutcome(result);
    }),

  approveTask: protectedProcedure
    .input(taskDecisionInputSchema)
    .mutation(async ({ ctx, input }) =>
      decideTask(ctx.session.user.id, input, "approve"),
    ),

  rejectTask: protectedProcedure
    .input(taskDecisionInputSchema)
    .mutation(async ({ ctx, input }) =>
      decideTask(ctx.session.user.id, input, "reject"),
    ),

  cancelTask: protectedProcedure
    .input(taskDecisionInputSchema)
    .mutation(async ({ ctx, input }) =>
      decideTask(ctx.session.user.id, input, "cancel"),
    ),

  taskEvents: protectedProcedure
    .input(taskEventsInputSchema)
    .subscription(async function* ({ ctx, input, signal }) {
      await ServerRuntime.runPromise(
        assertWorkflowProjectAccess({
          ownerUserId: ctx.session.user.id,
          projectId: input.projectId,
        }),
      ).catch(throwTRPCError);

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
      await ServerRuntime.runPromise(
        assertWorkflowProjectAccess({
          ownerUserId,
          projectId: input.projectId,
        }),
      ).catch(throwTRPCError);

      return ServerRuntime.runPromise(
        getTaskProjectionForWorkflow({
          ownerUserId,
          workflowId: input.projectId,
        }),
      ).catch(throwTRPCError);
    }),
});

async function decideTask(
  ownerUserId: string,
  input: z.infer<typeof taskDecisionInputSchema>,
  decision: "approve" | "cancel" | "reject",
) {
  await ServerRuntime.runPromise(
    assertWorkflowProjectAccess({
      ownerUserId,
      projectId: input.projectId,
    }),
  ).catch(throwTRPCError);
  await ServerRuntime.runPromise(
    assertTaskBelongsToProject({
      ownerUserId,
      taskId: input.taskId,
      workflowId: input.projectId,
    }),
  ).catch(throwTRPCError);

  const command = {
    ownerUserId,
    taskId: input.taskId,
    workflowId: input.projectId,
  };

  if (decision === "approve") {
    return unwrapRuntimeOutcome(
      await runRuntimeCommand((commands) => commands.approveTask(command)),
    );
  }

  if (decision === "cancel") {
    return unwrapRuntimeOutcome(
      await runRuntimeCommand((commands) => commands.cancelTask(command)),
    );
  }

  return unwrapRuntimeOutcome(
    await runRuntimeCommand((commands) => commands.rejectTask(command)),
  );
}

function assertTaskBelongsToProject(input: {
  readonly ownerUserId: string;
  readonly taskId: string;
  readonly workflowId: string;
}) {
  return Effect.gen(function* () {
    const database = yield* DatabaseService;
    const rows = yield* database.run(
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle;
        return yield* db
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              eq(tasks.id, input.taskId),
              eq(tasks.ownerUserId, input.ownerUserId),
              eq(tasks.workflowId, input.workflowId),
            ),
          )
          .limit(1);
      }),
    );

    if (!rows[0]) {
      return yield* Effect.fail(
        new TRPCError({
          code: "NOT_FOUND",
          message: "Task was not found for this workflow.",
        }),
      );
    }

    return rows[0];
  });
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

  if (error._tag === "TaskCancellationBlockedError") {
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

function getCurrentCreditBalance(ownerUserId: string) {
  return Effect.gen(function* () {
    const database = yield* DatabaseService;
    const rows = yield* database.run(
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle;
        return yield* db
          .select({ creditBalance: user.creditBalance })
          .from(user)
          .where(eq(user.id, ownerUserId))
          .limit(1);
      }),
    );
    const balance = rows[0]?.creditBalance;
    if (typeof balance === "number") {
      return balance;
    }
    if (typeof balance === "string" && /^-?\d+$/.test(balance)) {
      return Number(balance);
    }

    return yield* Effect.fail(
      new TRPCError({ code: "NOT_FOUND", message: "User was not found." }),
    );
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
