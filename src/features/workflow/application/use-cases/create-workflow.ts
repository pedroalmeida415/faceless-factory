import { Effect } from "effect";
import { WorkflowStore } from "~/features/workflow/application/store";

export const createWorkflow = (input: { readonly name: string; readonly userId: string }) =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore;

    return yield* store.createWorkflow(input);
  });
