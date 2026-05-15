import { Effect } from "effect";
import { WorkflowStore } from "~/features/workflow/application/store";

export const deleteWorkflow = (input: { readonly userId: string; readonly workflowId: string }) =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore;

    return yield* store.deleteWorkflow(input);
  });
