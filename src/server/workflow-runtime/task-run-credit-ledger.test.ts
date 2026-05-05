import { afterAll, beforeAll, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import {
  adjustTaskRunCostCredits,
  buildTaskRunCreditLedgerSourceKey,
  debitTaskRunCredits,
  refundTaskRunCredits,
} from "~/server/workflow-runtime/task-run-credit-ledger";

describe("Task Run credit ledger", () => {
  let client: PGlite;
  let db: PgliteDatabase;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client);
    await db.execute(sql`
      create table "user" (
        id text primary key,
        credit_balance bigint not null default 0
      )
    `);
    await db.execute(sql`
      create table credit_ledger_entries (
        id text primary key,
        user_id text not null,
        execution_id text,
        kind text not null,
        amount bigint not null,
        balance_after bigint not null,
        reason text not null,
        source_key text unique,
        created_at timestamp not null default now()
      )
    `);
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table credit_ledger_entries, "user"`);
    await db.execute(sql`
      insert into "user" (id, credit_balance)
      values ('owner-user', 100)
    `);
  });

  afterAll(async () => {
    await client.close();
  });

  test("idempotently debits, refunds, and adjusts cost through Task Run source keys", async () => {
    const command = {
      amount: 20,
      ownerUserId: "owner-user",
      taskRunId: "task-run-ledger",
      workflowId: "workflow-id",
    };

    assert.deepEqual(await debitTaskRunCredits(db, command), {
      debited: true,
    });
    assert.deepEqual(await debitTaskRunCredits(db, command), {
      debited: true,
    });
    await refundTaskRunCredits(db, { ...command, amount: 7 });
    await refundTaskRunCredits(db, { ...command, amount: 7 });
    await adjustTaskRunCostCredits(db, { ...command, amount: 3 });
    await adjustTaskRunCostCredits(db, { ...command, amount: 3 });

    assert.equal(await getUserCreditBalance(db), 84);
    assert.deepEqual(await getLedgerEntries(db), [
      {
        amount: 20,
        balanceAfter: 80,
        kind: "debit",
        reason: "task_run_debit",
        sourceKey: "task_run:task-run-ledger:debit",
      },
      {
        amount: 7,
        balanceAfter: 87,
        kind: "refund",
        reason: "task_run_refund",
        sourceKey: "task_run:task-run-ledger:refund",
      },
      {
        amount: 3,
        balanceAfter: 84,
        kind: "debit",
        reason: "task_run_cost_adjustment",
        sourceKey: "task_run:task-run-ledger:cost_adjustment",
      },
    ]);
  });

  test("source keys are unique per Task Run operation", () => {
    const operations = ["debit", "refund", "cost_adjustment"] as const;

    assert.deepEqual(
      operations.map((operation) =>
        buildTaskRunCreditLedgerSourceKey({
          operation,
          taskRunId: "task-run-source",
        }),
      ),
      [
        "task_run:task-run-source:debit",
        "task_run:task-run-source:refund",
        "task_run:task-run-source:cost_adjustment",
      ],
    );
  });
});

async function getUserCreditBalance(db: PgliteDatabase): Promise<number> {
  const result = await db.execute(sql`
    select credit_balance as "creditBalance"
    from "user"
    where id = 'owner-user'
  `);
  return Number(result.rows[0]?.creditBalance ?? 0);
}

async function getLedgerEntries(db: PgliteDatabase) {
  const result = await db.execute(sql`
    select amount, balance_after as "balanceAfter", kind, reason, source_key as "sourceKey"
    from credit_ledger_entries
    order by created_at asc, id asc
  `);
  return result.rows.map((row) => ({
    amount: Number(row.amount),
    balanceAfter: Number(row.balanceAfter),
    kind: row.kind,
    reason: row.reason,
    sourceKey: row.sourceKey,
  }));
}
