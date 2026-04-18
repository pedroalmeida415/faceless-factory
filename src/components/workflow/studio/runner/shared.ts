import type { Deferred, Effect } from "effect";
import type { RuntimeValue } from "~/components/workflow/studio/graph";
import type { WorkflowNode } from "~/components/workflow/studio/types";
import type {
  WorkflowExecutionError,
  WorkflowRequestError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import type { buildIncomingByTarget } from "../graph";
import type { WorkflowStudioStoreService } from "./store-service";

export type ClientWorkflowError =
  | WorkflowExecutionError
  | WorkflowRequestError
  | WorkflowValidationError;

export type IncomingByTarget = ReturnType<typeof buildIncomingByTarget>;
export type PendingMap = Map<
  string,
  Deferred.Deferred<RuntimeValue, ClientWorkflowError>
>;
export type NodeMap = Map<string, WorkflowNode>;
export type RunnerRequirements = WorkflowStudioStoreService;
export type EvaluateNode = (
  currentId: string,
  path: ReadonlySet<string>,
) => Effect.Effect<RuntimeValue, ClientWorkflowError, RunnerRequirements>;

export function formatRunningActivity(
  label: string,
  iterations: number,
  hasIterator: boolean,
) {
  return hasIterator
    ? `Running ${label} (${iterations} iterations)...`
    : `Running ${label}...`;
}
