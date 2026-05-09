type TaskLedgerOperation = "debit" | "refund" | "cost_adjustment";

export function buildTaskCreditLedgerSourceKey(input: {
  readonly operation: TaskLedgerOperation;
  readonly taskId: string;
}): string {
  return `task:${input.taskId}:${input.operation}`;
}
