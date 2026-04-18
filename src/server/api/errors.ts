import { TRPCError } from "@trpc/server";

import {
	getErrorMessage,
	WorkflowConfigError,
	WorkflowExecutionError,
	WorkflowGenerationError,
	WorkflowRequestError,
	WorkflowStorageError,
	WorkflowValidationError,
} from "~/lib/workflow/errors";

export function toTRPCError(error: unknown) {
	if (error instanceof TRPCError) {
		return error;
	}

	if (
		error instanceof WorkflowValidationError ||
		error instanceof WorkflowRequestError
	) {
		return new TRPCError({
			code: "BAD_REQUEST",
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
