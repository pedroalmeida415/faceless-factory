import { TRPCError } from "@trpc/server";

import {
  getErrorMessage,
  WorkflowAuthorizationError,
  WorkflowConfigError,
  WorkflowCreditsError,
  WorkflowExecutionError,
  WorkflowExecutionNotFoundError,
  WorkflowGenerationError,
  WorkflowRequestError,
  WorkflowStorageError,
  WorkflowValidationError,
} from "~/features/workflow/errors";

export function toTRPCError(error: unknown) {
  if (error instanceof TRPCError) {
    return error;
  }

  if (
    error instanceof WorkflowValidationError ||
    error instanceof WorkflowRequestError ||
    error instanceof WorkflowCreditsError
  ) {
    return new TRPCError({
      code: "BAD_REQUEST",
      message: error.message,
    });
  }

  if (error instanceof WorkflowExecutionNotFoundError) {
    return new TRPCError({
      code: "NOT_FOUND",
      message: error.message,
    });
  }

  if (error instanceof WorkflowAuthorizationError) {
    return new TRPCError({
      code: "UNAUTHORIZED",
      message: error.message,
    });
  }

  if (
    error instanceof WorkflowConfigError ||
    error instanceof WorkflowExecutionError ||
    error instanceof WorkflowGenerationError ||
    error instanceof WorkflowStorageError
  ) {
    return new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: error.message,
    });
  }

  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: getErrorMessage(error),
  });
}
