import { Effect } from "effect";
import { WorkflowValidationError } from "~/features/workflow/application/errors";
import { WorkflowStore } from "~/features/workflow/application/store";
import { type WorkflowGraphBlueprint, WorkflowGraphBlueprintSchema } from "~/features/workflow/domain/graph-blueprint";

export const saveWorkflow = (input: {
  readonly graph: WorkflowGraphBlueprint;
  readonly userId: string;
  readonly workflowId: string;
}) =>
  Effect.gen(function* () {
    const parsed = WorkflowGraphBlueprintSchema.safeParse(input.graph);

    if (!parsed.success) {
      return yield* Effect.fail(
        new WorkflowValidationError({
          cause: parsed.error,
          message: "Workflow graph is invalid.",
        }),
      );
    }

    const store = yield* WorkflowStore;

    return yield* store.saveWorkflow({
      graph: parsed.data,
      userId: input.userId,
      workflowId: input.workflowId,
    });
  });
