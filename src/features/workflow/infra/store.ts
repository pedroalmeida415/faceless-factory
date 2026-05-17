import type { SqlError } from "@effect/sql/SqlError";
import { and, desc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { DatabaseService } from "~/core/application/database-service";
import { WorkflowDatabaseError, WorkflowNotFoundError } from "~/features/workflow/application/errors";
import { WorkflowStore } from "~/features/workflow/application/store";
import { EMPTY_WORKFLOW_GRAPH } from "~/features/workflow/domain/graph";
import { workflows } from "~/main/database/schema";

export const WorkflowStoreLive = Layer.effect(
  WorkflowStore,
  Effect.gen(function* () {
    const database = yield* DatabaseService;

    return WorkflowStore.of({
      saveWorkflow: (input) =>
        Effect.gen(function* () {
          const [workflow] = yield* database
            .update(workflows)
            .set({ graph: input.graph })
            .where(and(eq(workflows.id, input.workflowId), eq(workflows.userId, input.userId)))
            .returning({ id: workflows.id });

          if (!workflow) {
            return yield* Effect.fail(
              new WorkflowNotFoundError({
                message: `Workflow ${input.workflowId} was not found.`,
              }),
            );
          }
        }).pipe(catchSqlError("Failed to save workflow graph.")),

      createWorkflow: (input) =>
        Effect.gen(function* () {
          const [workflow] = yield* database
            .insert(workflows)
            .values({
              graph: EMPTY_WORKFLOW_GRAPH,
              name: input.name,
              userId: input.userId,
            })
            .returning();

          if (!workflow) {
            return yield* Effect.fail(
              new WorkflowDatabaseError({
                message: `Database did not return newly created workflow.`,
              }),
            );
          }

          return {
            id: workflow.id,
            name: input.name,
          };
        }).pipe(catchSqlError("Failed to create workflows.")),

      deleteWorkflow: (input) =>
        Effect.gen(function* () {
          const [workflow] = yield* database
            .delete(workflows)
            .where(and(eq(workflows.id, input.workflowId), eq(workflows.userId, input.userId)))
            .returning({ id: workflows.id });

          if (!workflow) {
            return yield* Effect.fail(
              new WorkflowNotFoundError({
                message: `Workflow ${input.workflowId} was not found.`,
              }),
            );
          }
        }).pipe(catchSqlError("Failed to delete workflow.")),

      getWorkflow: (input) =>
        Effect.gen(function* () {
          const [workflow] = yield* database
            .select({
              graph: workflows.graph,
              id: workflows.id,
              name: workflows.name,
            })
            .from(workflows)
            .where(and(eq(workflows.id, input.workflowId), eq(workflows.userId, input.userId)))
            .limit(1);

          if (!workflow) {
            return yield* Effect.fail(
              new WorkflowNotFoundError({
                message: `Workflow ${input.workflowId} was not found.`,
              }),
            );
          }

          return workflow;
        }).pipe(catchSqlError("Failed to load workflows.")),

      listWorkflows: (userId) =>
        Effect.map(
          database
            .select({
              name: workflows.name,
              updatedAt: workflows.updatedAt,
              workflowId: workflows.id,
            })
            .from(workflows)
            .where(eq(workflows.userId, userId))
            .orderBy(desc(workflows.updatedAt)),
          (records) => records,
        ).pipe(catchSqlError("Failed to list workflows.")),

      renameWorkflow: (input) =>
        Effect.gen(function* () {
          const [workflow] = yield* database
            .update(workflows)
            .set({ name: input.name })
            .where(and(eq(workflows.id, input.workflowId), eq(workflows.userId, input.userId)))
            .returning({ id: workflows.id });

          if (!workflow) {
            return yield* Effect.fail(
              new WorkflowNotFoundError({
                message: `Workflow ${input.workflowId} was not found.`,
              }),
            );
          }
        }).pipe(catchSqlError("Failed to rename workflow.")),
    });
  }),
);

const catchSqlError =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E | SqlError, R>) =>
    effect.pipe(
      Effect.catchTag("SqlError", (error) =>
        Effect.fail(
          new WorkflowDatabaseError({
            cause: error,
            message,
          }),
        ),
      ),
    );
