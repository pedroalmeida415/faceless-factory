import { Context, Effect, Layer } from "effect";
import {
  getErrorMessage,
  WorkflowAuthorizationError,
  WorkflowInfrastructureError,
  WorkflowValidationError,
} from "~/features/workflow/errors";
import type { WorkflowProject } from "~/features/workflow/project";
import { getWorkflowProject } from "~/features/workflow/server/projects";

type ProjectStoreError =
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

export class ProjectStoreService extends Context.Tag("ProjectStoreService")<
  ProjectStoreService,
  {
    readonly getProject: (params: {
      ownerUserId: string;
      projectId: string;
    }) => Effect.Effect<WorkflowProject, ProjectStoreError>;
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
