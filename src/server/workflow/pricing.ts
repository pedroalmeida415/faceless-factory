import { Effect } from "effect";

import {
  WorkflowAuthorizationError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import type { StartWorkflowExecutionRequest } from "~/lib/workflow/execution/types";
import {
  estimateWorkflowExecution,
  priceImageGeneration,
  priceVideoGeneration,
  quoteWorkflowExecution as quoteWorkflowExecutionLocally,
  type WorkflowExecutionPriceLineItem,
  type WorkflowExecutionPriceQuote,
} from "~/lib/workflow/pricing";
import { assertWorkflowProjectAccess } from "~/server/workflow/projects";

export function quoteWorkflowExecution(params: {
  request: StartWorkflowExecutionRequest;
  userId: string;
}) {
  return Effect.gen(function* () {
    const projectId = params.request.projectId?.trim();
    if (!projectId) {
      return yield* Effect.fail(
        new WorkflowValidationError({
          message: "A workflow project is required to quote execution.",
        }),
      );
    }

    yield* Effect.tryPromise({
      try: () =>
        assertWorkflowProjectAccess({
          ownerUserId: params.userId,
          projectId,
        }),
      catch: (cause) =>
        cause instanceof WorkflowAuthorizationError ||
        cause instanceof WorkflowValidationError
          ? cause
          : new WorkflowValidationError({
              message: "Failed to quote workflow execution.",
              cause,
            }),
    });

    return quoteWorkflowExecutionLocally(params.request);
  });
}

export {
  estimateWorkflowExecution,
  priceImageGeneration,
  priceVideoGeneration,
  type WorkflowExecutionPriceLineItem,
  type WorkflowExecutionPriceQuote,
};
