import { Effect } from "effect";
import { WorkflowValidationError } from "~/features/workflow/application/errors";
import { WorkflowStore } from "~/features/workflow/application/store";
import {
  createWorkflowGraph,
  type WorkflowGraphDraft,
  WorkflowGraphDraftSchema,
} from "~/features/workflow/domain/graph";

export const saveWorkflow = (input: {
  readonly graph: WorkflowGraphDraft;
  readonly userId: string;
  readonly workflowId: string;
}) =>
  Effect.gen(function* () {
    const parsed = WorkflowGraphDraftSchema.safeParse(input.graph);

    if (!parsed.success) {
      return yield* Effect.fail(
        new WorkflowValidationError({
          cause: parsed.error,
          message: "Workflow graph is invalid.",
        }),
      );
    }

    const store = yield* WorkflowStore;
    const graph = createWorkflowGraph(parsed.data);

    return yield* store.saveWorkflow({
      graph,
      userId: input.userId,
      workflowId: input.workflowId,
    });
  });
