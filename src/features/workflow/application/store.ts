import { Context, type Effect } from "effect";
import type { WorkflowDatabaseError, WorkflowNotFoundError } from "~/features/workflow/application/errors";
import type { WorkflowGraphProjection, WorkflowSummaryProjection } from "~/features/workflow/application/models";
import type { WorkflowGraphBlueprint } from "~/features/workflow/domain/graph-blueprint";

export class WorkflowStore extends Context.Tag("WorkflowStore")<
  WorkflowStore,
  {
    readonly saveWorkflow: (input: {
      readonly graph: WorkflowGraphBlueprint;
      readonly userId: string;
      readonly workflowId: string;
    }) => Effect.Effect<WorkflowGraphProjection, WorkflowDatabaseError | WorkflowNotFoundError>;
    readonly createWorkflow: (input: {
      readonly name: string;
      readonly userId: string;
    }) => Effect.Effect<WorkflowGraphProjection, WorkflowDatabaseError>;
    readonly getWorkflow: (input: {
      readonly userId: string;
      readonly workflowId: string;
    }) => Effect.Effect<WorkflowGraphProjection, WorkflowDatabaseError | WorkflowNotFoundError>;
    readonly listWorkflows: (
      userId: string,
    ) => Effect.Effect<readonly WorkflowSummaryProjection[], WorkflowDatabaseError>;
  }
>() {}
