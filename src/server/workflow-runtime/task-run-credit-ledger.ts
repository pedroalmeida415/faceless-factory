import { type SQL, sql } from "drizzle-orm";

type DbExecutor = {
  readonly execute: (query: SQL) => Promise<unknown>;
};

type QueryRow = Record<string, unknown>;

type TaskRunCreditLedgerCommand = {
  readonly amount: number;
  readonly ownerUserId: string;
  readonly taskRunId: string;
  readonly workflowId: string;
};

type TaskRunCreditDebitResult =
  | { readonly debited: true }
  | { readonly debited: false; readonly reason: "INSUFFICIENT_CREDITS" };

type TaskRunLedgerOperation = "debit" | "refund" | "cost_adjustment";

export async function debitTaskRunCredits(
  db: DbExecutor,
  command: TaskRunCreditLedgerCommand,
): Promise<TaskRunCreditDebitResult> {
  if (command.amount <= 0) {
    return { debited: true };
  }

  const balance = await lockUserAndReadBalance(db, command.ownerUserId);
  const sourceKey = buildTaskRunCreditLedgerSourceKey({
    operation: "debit",
    taskRunId: command.taskRunId,
  });
  if (await hasLedgerEntry(db, sourceKey)) {
    return { debited: true };
  }
  if (balance < command.amount) {
    return { debited: false, reason: "INSUFFICIENT_CREDITS" };
  }

  await insertBalanceChangingLedgerEntry(db, {
    ...command,
    balanceDelta: -command.amount,
    kind: "debit",
    reason: "task_run_debit",
    sourceKey,
  });
  return { debited: true };
}

export async function refundTaskRunCredits(
  db: DbExecutor,
  command: TaskRunCreditLedgerCommand,
): Promise<void> {
  if (command.amount <= 0) {
    return;
  }

  const sourceKey = buildTaskRunCreditLedgerSourceKey({
    operation: "refund",
    taskRunId: command.taskRunId,
  });
  await lockUserAndReadBalance(db, command.ownerUserId);
  if (await hasLedgerEntry(db, sourceKey)) {
    return;
  }

  await insertBalanceChangingLedgerEntry(db, {
    ...command,
    balanceDelta: command.amount,
    kind: "refund",
    reason: "task_run_refund",
    sourceKey,
  });
}

export async function adjustTaskRunCostCredits(
  db: DbExecutor,
  command: TaskRunCreditLedgerCommand,
): Promise<void> {
  if (command.amount <= 0) {
    return;
  }

  const sourceKey = buildTaskRunCreditLedgerSourceKey({
    operation: "cost_adjustment",
    taskRunId: command.taskRunId,
  });
  await lockUserAndReadBalance(db, command.ownerUserId);
  if (await hasLedgerEntry(db, sourceKey)) {
    return;
  }

  await insertBalanceChangingLedgerEntry(db, {
    ...command,
    balanceDelta: -command.amount,
    kind: "debit",
    reason: "task_run_cost_adjustment",
    sourceKey,
  });
}

export function buildTaskRunCreditLedgerSourceKey(input: {
  readonly operation: TaskRunLedgerOperation;
  readonly taskRunId: string;
}): string {
  return `task_run:${input.taskRunId}:${input.operation}`;
}

async function lockUserAndReadBalance(
  db: DbExecutor,
  ownerUserId: string,
): Promise<number> {
  const rows = rowsFromResult(
    await db.execute(sql`
      select credit_balance as "creditBalance"
      from "user"
      where id = ${ownerUserId}
      for update
    `),
  );
  const row = rows[0];
  if (!row) {
    throw new TypeError(`Missing owner user ${ownerUserId}`);
  }

  return requireNumber(row.creditBalance);
}

async function hasLedgerEntry(
  db: DbExecutor,
  sourceKey: string,
): Promise<boolean> {
  const rows = rowsFromResult(
    await db.execute(sql`
      select id
      from credit_ledger_entries
      where source_key = ${sourceKey}
      limit 1
    `),
  );
  return rows.length > 0;
}

async function insertBalanceChangingLedgerEntry(
  db: DbExecutor,
  input: TaskRunCreditLedgerCommand & {
    readonly balanceDelta: number;
    readonly kind: "debit" | "refund";
    readonly reason: string;
    readonly sourceKey: string;
  },
): Promise<void> {
  const rows = rowsFromResult(
    await db.execute(sql`
      update "user"
      set credit_balance = credit_balance + ${input.balanceDelta}
      where id = ${input.ownerUserId}
      returning credit_balance as "creditBalance"
    `),
  );
  const row = rows[0];
  if (!row) {
    throw new TypeError(`Missing owner user ${input.ownerUserId}`);
  }

  await db.execute(sql`
    insert into credit_ledger_entries (
      id,
      user_id,
      execution_id,
      kind,
      amount,
      balance_after,
      reason,
      source_key,
      created_at
    ) values (
      ${input.sourceKey},
      ${input.ownerUserId},
      ${input.workflowId},
      ${input.kind},
      ${input.amount},
      ${requireNumber(row.creditBalance)},
      ${input.reason},
      ${input.sourceKey},
      now()
    )
  `);
}

function rowsFromResult(result: unknown): readonly QueryRow[] {
  if (Array.isArray(result)) {
    return result.filter(isQueryRow);
  }

  if (isQueryRow(result) && Array.isArray(result.rows)) {
    return result.rows.filter(isQueryRow);
  }

  return [];
}

function isQueryRow(value: unknown): value is QueryRow {
  return typeof value === "object" && value !== null;
}

function requireNumber(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  throw new TypeError("Expected integer database value");
}
