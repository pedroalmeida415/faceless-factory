import { Effect } from "effect";
import { WorkflowStore } from "~/features/workflow/application/store";

export const renameWorkflow = (input: {
  readonly name: string;
  readonly userId: string;
  readonly workflowId: string;
}) =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore;

    return yield* store.renameWorkflow(input);
  });
