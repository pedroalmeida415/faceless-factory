import { Data } from "effect";

export class WorkflowDatabaseError extends Data.TaggedError("WorkflowDatabaseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkflowNotFoundError extends Data.TaggedError("WorkflowNotFoundError")<{
  readonly message: string;
}> {}

export class WorkflowValidationError extends Data.TaggedError("WorkflowValidationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
