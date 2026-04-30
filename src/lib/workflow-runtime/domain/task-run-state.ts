export const taskRunStatusValues = [
  "WAITING_UPSTREAM",
  "QUEUED",
  "RUNNING",
  "PENDING_REVIEW",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "FAILED",
  "UPSTREAM_FAILED",
] as const;

export type TaskRunStatus = (typeof taskRunStatusValues)[number];

export const taskRunFailureReasonTypeValues = [
  "INSUFFICIENT_CREDITS",
  "PROVIDER_FAILED",
  "EXECUTION_FAILED",
  "UPSTREAM_FAILED",
] as const;

export type TaskRunFailureReasonType =
  (typeof taskRunFailureReasonTypeValues)[number];

export type TaskRunCoordinate = {
  readonly nodeExecutionId: string;
  readonly itemIndex: number;
  readonly attempt: number;
};

export type TaskRunFailureReason =
  | { readonly type: Extract<TaskRunFailureReasonType, "INSUFFICIENT_CREDITS"> }
  | {
      readonly type: Extract<TaskRunFailureReasonType, "PROVIDER_FAILED">;
      readonly message: string;
    }
  | {
      readonly type: Extract<TaskRunFailureReasonType, "EXECUTION_FAILED">;
      readonly message: string;
    }
  | {
      readonly type: Extract<TaskRunFailureReasonType, "UPSTREAM_FAILED">;
      readonly failedParentTaskRunId: string;
    };

const terminalTaskRunStatuses = new Set<TaskRunStatus>([
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "FAILED",
  "UPSTREAM_FAILED",
]);

export function isTerminalTaskRunStatus(
  status: TaskRunStatus,
): status is Extract<
  TaskRunStatus,
  "APPROVED" | "REJECTED" | "CANCELLED" | "FAILED" | "UPSTREAM_FAILED"
> {
  return terminalTaskRunStatuses.has(status);
}

export function isActiveTaskRunStatus(
  status: TaskRunStatus,
): status is Extract<
  TaskRunStatus,
  "WAITING_UPSTREAM" | "QUEUED" | "RUNNING" | "PENDING_REVIEW"
> {
  return !isTerminalTaskRunStatus(status);
}

export function isTaskRunDependencySatisfiedStatus(
  status: TaskRunStatus,
): status is "APPROVED" {
  return status === "APPROVED";
}

export function isRecoverableByDownstreamPlanningStatus(
  status: TaskRunStatus,
): status is Extract<
  TaskRunStatus,
  "CANCELLED" | "FAILED" | "UPSTREAM_FAILED"
> {
  return (
    status === "CANCELLED" ||
    status === "FAILED" ||
    status === "UPSTREAM_FAILED"
  );
}

export function isRenderableTaskRunStatus(
  status: TaskRunStatus,
): status is "PENDING_REVIEW" | "APPROVED" | "REJECTED" {
  return (
    status === "PENDING_REVIEW" ||
    status === "APPROVED" ||
    status === "REJECTED"
  );
}

export function buildTaskRunCoordinateKey(
  coordinate: TaskRunCoordinate,
): string {
  return `${coordinate.nodeExecutionId}:item:${coordinate.itemIndex}:attempt:${coordinate.attempt}`;
}

export function buildTaskRunIdempotencyKey(input: {
  readonly taskRunId: string;
  readonly attempt: number;
}): string {
  return `task_run:${input.taskRunId}:attempt:${input.attempt}`;
}

export function isDirectTaskRunFailureReason(
  reason: TaskRunFailureReason,
): reason is Exclude<
  TaskRunFailureReason,
  { readonly type: "UPSTREAM_FAILED" }
> {
  return reason.type !== "UPSTREAM_FAILED";
}

export function isUpstreamTaskRunFailureReason(
  reason: TaskRunFailureReason,
): reason is Extract<
  TaskRunFailureReason,
  { readonly type: "UPSTREAM_FAILED" }
> {
  return reason.type === "UPSTREAM_FAILED";
}
