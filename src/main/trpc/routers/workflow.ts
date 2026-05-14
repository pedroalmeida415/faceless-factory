import { TRPCError } from "@trpc/server";
import { Effect } from "effect";
import { z } from "zod";
import {
  type WorkflowDatabaseError,
  WorkflowNotFoundError,
  WorkflowValidationError,
} from "~/features/workflow/application/errors";
import { createWorkflow } from "~/features/workflow/application/use-cases/create-workflow";
import { getWorkflow } from "~/features/workflow/application/use-cases/get-workflow";
import { listWorkflows } from "~/features/workflow/application/use-cases/list-workflows";
import { saveWorkflow } from "~/features/workflow/application/use-cases/save-workflow";
import { WorkflowGraphBlueprintSchema } from "~/features/workflow/domain/graph-blueprint";
import { ServerRuntimeLive } from "~/main/effect";
import { createTRPCRouter, protectedProcedure } from "~/main/trpc/root";

export const workflowRouter = createTRPCRouter({
  saveWorkflow: protectedProcedure
    .input(
      z.object({
        graph: WorkflowGraphBlueprintSchema,
        workflowId: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) =>
      ServerRuntimeLive.runPromise(
        saveWorkflow({
          graph: input.graph,
          userId: ctx.session.user.id,
          workflowId: input.workflowId,
        }).pipe(Effect.mapError(toTrpcError)),
      ),
    ),
  createWorkflow: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120).default("Untitled workflow"),
      }),
    )
    .mutation(({ ctx, input }) =>
      ServerRuntimeLive.runPromise(
        createWorkflow({ name: input.name, userId: ctx.session.user.id }).pipe(Effect.mapError(toTrpcError)),
      ),
    ),
  getWorkflow: protectedProcedure
    .input(
      z.object({
        workflowId: z.string().min(1),
      }),
    )
    .query(({ ctx, input }) =>
      ServerRuntimeLive.runPromise(
        getWorkflow({ userId: ctx.session.user.id, workflowId: input.workflowId }).pipe(Effect.mapError(toTrpcError)),
      ),
    ),
  listWorkflows: protectedProcedure.query(({ ctx }) =>
    ServerRuntimeLive.runPromise(listWorkflows(ctx.session.user.id).pipe(Effect.mapError(toTrpcError))),
  ),
});

type WorkflowRouterError = WorkflowDatabaseError | WorkflowNotFoundError | WorkflowValidationError;

function toTrpcError(cause: WorkflowRouterError) {
  const message = cause.message;

  if (cause instanceof WorkflowNotFoundError) {
    return new TRPCError({
      cause,
      code: "NOT_FOUND",
      message,
    });
  }

  if (cause instanceof WorkflowValidationError) {
    return new TRPCError({
      cause,
      code: "BAD_REQUEST",
      message,
    });
  }

  return new TRPCError({
    cause,
    code: "INTERNAL_SERVER_ERROR",
    message,
  });
}
