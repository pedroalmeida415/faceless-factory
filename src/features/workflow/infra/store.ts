import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { DatabaseService } from "~/core/application/database-service";
import { WorkflowDatabaseError, WorkflowNotFoundError } from "~/features/workflow/application/errors";
import { toWorkflowGraphProjection } from "~/features/workflow/application/models";
import { WorkflowStore } from "~/features/workflow/application/store";
import { EMPTY_WORKFLOW_GRAPH_BLUEPRINT } from "~/features/workflow/domain/graph-blueprint";
import { workflows } from "~/main/database/schema";

export const WorkflowStoreLive = Layer.effect(
  WorkflowStore,
  Effect.gen(function* () {
    const database = yield* DatabaseService;

    const loadWorkflow = (input: { readonly userId: string; readonly workflowId: string }) =>
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
      });

    return WorkflowStore.of({
      saveWorkflow: (input) =>
        mapWorkflowDatabaseError(
          Effect.gen(function* () {
            const workflow = yield* loadWorkflow(input);
            const now = new Date();

            yield* database
              .update(workflows)
              .set({ graph: input.graph, updatedAt: now })
              .where(and(eq(workflows.id, input.workflowId), eq(workflows.userId, input.userId)));

            return toWorkflowGraphProjection({
              graph: input.graph,
              name: workflow.name,
              workflowId: input.workflowId,
            });
          }),
          "Failed to save workflow graph.",
        ),
      createWorkflow: (input) =>
        mapWorkflowDatabaseError(
          Effect.gen(function* () {
            const workflowId = randomUUID();
            const now = new Date();

            yield* database.insert(workflows).values({
              createdAt: now,
              graph: EMPTY_WORKFLOW_GRAPH_BLUEPRINT,
              id: workflowId,
              name: input.name,
              updatedAt: now,
              userId: input.userId,
            });

            return toWorkflowGraphProjection({
              graph: EMPTY_WORKFLOW_GRAPH_BLUEPRINT,
              name: input.name,
              workflowId,
            });
          }),
          "Failed to create workflow.",
        ),
      getWorkflow: (input) =>
        mapWorkflowDatabaseError(
          Effect.gen(function* () {
            const workflow = yield* loadWorkflow(input);

            return toWorkflowGraphProjection({
              graph: workflow.graph,
              name: workflow.name,
              workflowId: workflow.id,
            });
          }),
          "Failed to load workflow.",
        ),
      listWorkflows: (userId) =>
        mapWorkflowDatabaseError(
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
          ),
          "Failed to list workflows.",
        ),
    });
  }),
);

function mapWorkflowDatabaseError<A, E>(effect: Effect.Effect<A, E>, failureMessage: string) {
  return Effect.mapError(effect, (cause) =>
    cause instanceof WorkflowDatabaseError || cause instanceof WorkflowNotFoundError
      ? cause
      : new WorkflowDatabaseError({ cause, message: failureMessage }),
  );
}
