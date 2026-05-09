export const taskStatusValues = [
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

export type TaskStatus = (typeof taskStatusValues)[number];

export const taskFailureReasonTypeValues = [
  "INSUFFICIENT_CREDITS",
  "PROVIDER_FAILED",
  "EXECUTION_FAILED",
  "UPSTREAM_FAILED",
] as const;

export type TaskFailureReasonType =
  (typeof taskFailureReasonTypeValues)[number];

export type TaskCoordinate = {
  readonly nodeRunId: string;
  readonly branchIndex: number;
};

export type TaskFailureReason =
  | { readonly type: Extract<TaskFailureReasonType, "INSUFFICIENT_CREDITS"> }
  | {
      readonly type: Extract<TaskFailureReasonType, "PROVIDER_FAILED">;
      readonly message: string;
    }
  | {
      readonly type: Extract<TaskFailureReasonType, "EXECUTION_FAILED">;
      readonly message: string;
    }
  | {
      readonly type: Extract<TaskFailureReasonType, "UPSTREAM_FAILED">;
      readonly failedParentTaskId: string;
    };

export type TaskSettlementFailureSource =
  | {
      readonly taskDebitRefundable: boolean;
      readonly type: "PROVIDER";
    }
  | {
      readonly taskDebitRefundable: false;
      readonly type: "POST_PROVIDER_INFRASTRUCTURE";
    };

const terminalTaskStatuses = new Set<TaskStatus>([
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "FAILED",
  "UPSTREAM_FAILED",
]);

export function isTerminalTaskStatus(
  status: TaskStatus,
): status is Extract<
  TaskStatus,
  "APPROVED" | "REJECTED" | "CANCELLED" | "FAILED" | "UPSTREAM_FAILED"
> {
  return terminalTaskStatuses.has(status);
}

export function isActiveTaskStatus(
  status: TaskStatus,
): status is Extract<
  TaskStatus,
  "WAITING_UPSTREAM" | "QUEUED" | "RUNNING" | "PENDING_REVIEW"
> {
  return !isTerminalTaskStatus(status);
}

export function isFailedTaskStatus(
  status: TaskStatus,
): status is Extract<TaskStatus, "FAILED" | "UPSTREAM_FAILED"> {
  return status === "FAILED" || status === "UPSTREAM_FAILED";
}

export function isTaskDependencySatisfiedStatus(
  status: TaskStatus,
): status is "APPROVED" {
  return status === "APPROVED";
}

export function isRecoverableByDownstreamPlanningStatus(
  status: TaskStatus,
): status is Extract<TaskStatus, "CANCELLED" | "FAILED" | "UPSTREAM_FAILED"> {
  return (
    status === "CANCELLED" ||
    status === "FAILED" ||
    status === "UPSTREAM_FAILED"
  );
}

export function isRenderableTaskStatus(
  status: TaskStatus,
): status is "PENDING_REVIEW" | "APPROVED" | "REJECTED" {
  return (
    status === "PENDING_REVIEW" ||
    status === "APPROVED" ||
    status === "REJECTED"
  );
}

export function buildTaskCoordinateKey(coordinate: TaskCoordinate): string {
  return `${coordinate.nodeRunId}:branch:${coordinate.branchIndex}`;
}

export function buildTaskIdempotencyKey(input: {
  readonly taskId: string;
}): string {
  return `task:${input.taskId}`;
}

export function isDirectTaskFailureReason(
  reason: TaskFailureReason,
): reason is Exclude<TaskFailureReason, { readonly type: "UPSTREAM_FAILED" }> {
  return reason.type !== "UPSTREAM_FAILED";
}

export function isUpstreamTaskFailureReason(
  reason: TaskFailureReason,
): reason is Extract<TaskFailureReason, { readonly type: "UPSTREAM_FAILED" }> {
  return reason.type === "UPSTREAM_FAILED";
}
