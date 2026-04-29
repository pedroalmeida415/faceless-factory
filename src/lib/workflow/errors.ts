import { Data } from "effect";

export class WorkflowConfigError extends Data.TaggedError(
  "WorkflowConfigError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkflowExecutionError extends Data.TaggedError(
  "WorkflowExecutionError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkflowGenerationError extends Data.TaggedError(
  "WorkflowGenerationError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkflowRequestError extends Data.TaggedError(
  "WorkflowRequestError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkflowInfrastructureError extends Data.TaggedError(
  "WorkflowInfrastructureError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkflowStorageError extends Data.TaggedError(
  "WorkflowStorageError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkflowExecutionNotFoundError extends Data.TaggedError(
  "WorkflowExecutionNotFoundError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkflowAuthorizationError extends Data.TaggedError(
  "WorkflowAuthorizationError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkflowCreditsError extends Data.TaggedError(
  "WorkflowCreditsError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkflowValidationError extends Data.TaggedError(
  "WorkflowValidationError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return "Unexpected workflow failure.";
}
