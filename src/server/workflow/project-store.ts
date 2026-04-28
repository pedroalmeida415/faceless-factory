import { Context, Effect, Layer } from "effect";
import {
  getErrorMessage,
  WorkflowAuthorizationError,
  WorkflowInfrastructureError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import type { WorkflowProject } from "~/lib/workflow/project";
import { getWorkflowProject } from "~/server/workflow/projects";

type WorkflowProjectStoreError =
  | WorkflowAuthorizationError
  | WorkflowInfrastructureError
  | WorkflowValidationError;

function toProjectStoreError(cause: unknown) {
  return cause instanceof WorkflowAuthorizationError ||
    cause instanceof WorkflowInfrastructureError ||
    cause instanceof WorkflowValidationError
    ? cause
    : new WorkflowInfrastructureError({
        message: getErrorMessage(cause),
        cause,
      });
}

export class WorkflowProjectStore extends Context.Tag("WorkflowProjectStore")<
  WorkflowProjectStore,
  {
    readonly getProject: (params: {
      ownerUserId: string;
      projectId: string;
    }) => Effect.Effect<WorkflowProject, WorkflowProjectStoreError>;
  }
>() {
  static readonly Live = Layer.succeed(this, {
    getProject: (params) =>
      Effect.tryPromise({
        try: () => getWorkflowProject(params),
        catch: toProjectStoreError,
      }),
  });
}
