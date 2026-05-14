import { Effect } from "effect";
import { WorkflowStore } from "~/features/workflow/application/store";

export const listWorkflows = (userId: string) =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore;

    return yield* store.listWorkflows(userId);
  });
