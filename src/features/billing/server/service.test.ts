import { beforeAll, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { SqlClient } from "@effect/sql";
import { type Context, Effect } from "effect";

import {
  BillingUserNotFoundError,
  handleSuccessfulTopUpPayment,
  syncSubscriptionCreditsForUser,
} from "~/features/billing/server/service";
import { ServerTestRuntime } from "~/server/effect";
import { DatabaseService } from "~/server/services/database";

let database: Context.Tag.Service<typeof DatabaseService>;

describe.serial("billing subscription credits", () => {
  beforeAll(async () => {
    database = await ServerTestRuntime.runPromise(DatabaseService);
  });

  beforeEach(async () => {
    await ServerTestRuntime.runPromise(
      database.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`delete from credit_ledger_entries`;
          yield* sql`delete from subscription`;
          yield* sql`delete from "user"`;
          yield* sql`insert into "user" (id, name, email, email_verified, credit_balance, created_at, updated_at) values ('billing-user', 'Billing User', 'billing@example.com', false, 0, now(), now())`;
        }),
      ),
    );
  });

  test("grants elapsed monthly subscription credits once through DatabaseService", async () => {
    await ServerTestRuntime.runPromise(
      database.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`insert into subscription (id, plan, reference_id, status, period_start, period_end) values ('sub-1', 'starter', 'billing-user', 'active', '2026-01-15T00:00:00.000Z', '2026-04-15T00:00:00.000Z')`;
        }),
      ),
    );

    const firstGrant = await ServerTestRuntime.runPromise(
      syncSubscriptionCreditsForUser("billing-user"),
    );
    const secondGrant = await ServerTestRuntime.runPromise(
      syncSubscriptionCreditsForUser("billing-user"),
    );
    const [summary] = await ServerTestRuntime.runPromise(
      database.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            creditBalance: number;
            ledgerEntries: number;
          }>`select u.credit_balance as "creditBalance", count(l.id)::int as "ledgerEntries" from "user" u left join credit_ledger_entries l on l.user_id = u.id where u.id = 'billing-user' group by u.credit_balance`;
        }),
      ),
    );

    assert.ok(summary);
    assert.equal(firstGrant, 4500);
    assert.equal(secondGrant, 0);
    assert.equal(summary.creditBalance, 4500);
    assert.equal(summary.ledgerEntries, 3);
  });

  test("reports missing top-up users as a typed billing error", async () => {
    const result = await ServerTestRuntime.runPromise(
      Effect.either(
        handleSuccessfulTopUpPayment({
          id: "pi_missing_billing_user",
          metadata: {
            billingType: "credit-topup",
            credits: "1500",
            userId: "missing-billing-user",
          },
        }),
      ),
    );

    assert.equal(result._tag, "Left");
    if (result._tag === "Left") {
      assert.ok(result.left instanceof BillingUserNotFoundError);
    }

    const [summary] = await ServerTestRuntime.runPromise(
      database.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            ledgerEntries: number;
          }>`select count(*)::int as "ledgerEntries" from credit_ledger_entries where source_key = 'payment-intent:pi_missing_billing_user'`;
        }),
      ),
    );

    assert.equal(summary?.ledgerEntries, 0);
  });
});
