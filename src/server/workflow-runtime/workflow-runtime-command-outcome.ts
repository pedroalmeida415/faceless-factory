export type WorkflowRuntimeIgnoredReason =
  | "STALE_TASK_RUN"
  | "WAKE_UP_PARENT_NOT_FOUND";

export type WorkflowRuntimeCommandOutcome<T> =
  | { readonly status: "committed"; readonly value: T }
  | {
      readonly reason: WorkflowRuntimeIgnoredReason;
      readonly status: "ignored";
    };

const postCommitWorkTransportKeys = new Set([
  "event",
  "executionJob",
  "executionJobs",
  "taskStatusEvents",
  "wakeUpJob",
  "wakeUpJobs",
]);

export function committed<T>(value: T): WorkflowRuntimeCommandOutcome<T> {
  return { status: "committed", value };
}

export function ignored<T>(
  reason: WorkflowRuntimeIgnoredReason,
): WorkflowRuntimeCommandOutcome<T> {
  return { reason, status: "ignored" };
}

export function toWorkflowRuntimeTransportOutcome<T>(
  outcome: WorkflowRuntimeCommandOutcome<T>,
) {
  if (outcome.status === "ignored") {
    return outcome;
  }

  return {
    status: "committed",
    value: sanitizeWorkflowRuntimeTransportValue(outcome.value),
  } as const;
}

export function sanitizeWorkflowRuntimeProcessorOutcome(outcome: unknown) {
  if (!isWorkflowRuntimeCommandOutcome(outcome)) {
    return outcome;
  }

  return toWorkflowRuntimeTransportOutcome(outcome);
}

function sanitizeWorkflowRuntimeTransportValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeWorkflowRuntimeTransportValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      postCommitWorkTransportKeys.has(key)
        ? []
        : [[key, sanitizeWorkflowRuntimeTransportValue(child)]],
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkflowRuntimeCommandOutcome(
  value: unknown,
): value is WorkflowRuntimeCommandOutcome<unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.status === "committed" && "value" in value) ||
    (value.status === "ignored" && typeof value.reason === "string")
  );
}
