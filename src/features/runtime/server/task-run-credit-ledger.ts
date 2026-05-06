type TaskRunLedgerOperation = "debit" | "refund" | "cost_adjustment";

export function buildTaskRunCreditLedgerSourceKey(input: {
  readonly operation: TaskRunLedgerOperation;
  readonly taskRunId: string;
}): string {
  return `task_run:${input.taskRunId}:${input.operation}`;
}
