export type RuntimeIgnoredReason =
  | "STALE_TASK_RUN"
  | "WAKE_UP_PARENT_NOT_FOUND";

export type RuntimeCommandOutcome<T> =
  | { readonly status: "committed"; readonly value: T }
  | {
      readonly reason: RuntimeIgnoredReason;
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

export function committed<T>(value: T): RuntimeCommandOutcome<T> {
  return { status: "committed", value };
}

export function ignored<T>(
  reason: RuntimeIgnoredReason,
): RuntimeCommandOutcome<T> {
  return { reason, status: "ignored" };
}

export function toRuntimeTransportOutcome<T>(
  outcome: RuntimeCommandOutcome<T>,
) {
  if (outcome.status === "ignored") {
    return outcome;
  }

  return {
    status: "committed",
    value: sanitizeRuntimeTransportValue(outcome.value),
  } as const;
}

export function sanitizeRuntimeProcessorOutcome(outcome: unknown) {
  if (!isRuntimeCommandOutcome(outcome)) {
    return outcome;
  }

  return toRuntimeTransportOutcome(outcome);
}

function sanitizeRuntimeTransportValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeRuntimeTransportValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      postCommitWorkTransportKeys.has(key)
        ? []
        : [[key, sanitizeRuntimeTransportValue(child)]],
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRuntimeCommandOutcome(
  value: unknown,
): value is RuntimeCommandOutcome<unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.status === "committed" && "value" in value) ||
    (value.status === "ignored" && typeof value.reason === "string")
  );
}
