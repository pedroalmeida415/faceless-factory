import { Context, type Effect } from "effect";
import type { WorkflowDatabaseError, WorkflowNotFoundError } from "~/features/workflow/application/errors";
import type { WorkflowGraph } from "~/features/workflow/domain/graph";

export class WorkflowStore extends Context.Tag("WorkflowStore")<
  WorkflowStore,
  {
    readonly saveWorkflow: (input: {
      readonly graph: WorkflowGraph;
      readonly userId: string;
      readonly workflowId: string;
    }) => Effect.Effect<void, WorkflowDatabaseError | WorkflowNotFoundError>;

    readonly createWorkflow: (input: { readonly name: string; readonly userId: string }) => Effect.Effect<
      {
        id: string;
        name: string;
      },
      WorkflowDatabaseError
    >;

    readonly deleteWorkflow: (input: {
      readonly userId: string;
      readonly workflowId: string;
    }) => Effect.Effect<void, WorkflowDatabaseError | WorkflowNotFoundError>;

    readonly getWorkflow: (input: { readonly userId: string; readonly workflowId: string }) => Effect.Effect<
      {
        readonly graph: WorkflowGraph;
        readonly id: string;
        readonly name: string;
      },
      WorkflowDatabaseError | WorkflowNotFoundError
    >;

    readonly listWorkflows: (userId: string) => Effect.Effect<
      readonly {
        readonly name: string;
        readonly updatedAt: Date;
        readonly workflowId: string;
      }[],
      WorkflowDatabaseError
    >;

    readonly renameWorkflow: (input: {
      readonly name: string;
      readonly userId: string;
      readonly workflowId: string;
    }) => Effect.Effect<void, WorkflowDatabaseError | WorkflowNotFoundError>;
  }
>() {}
