import { randomUUID } from "node:crypto";

import { and, eq, gte, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import {
  getErrorMessage,
  WorkflowCreditsError,
  WorkflowInfrastructureError,
} from "~/lib/workflow/errors";
import type { WorkflowCreditsSummary } from "~/lib/workflow/execution/types";
import { syncSubscriptionCreditsForUser } from "~/server/billing/service";
import { db } from "~/server/db";
import { creditLedgerEntries, user } from "~/server/db/schema";

type SelectExecutor = Pick<typeof db, "select">;

function buildBalanceSummary(available: number): WorkflowCreditsSummary {
  return {
    available,
    reserved: 0,
    totalCost: 0,
    used: 0,
  };
}

function buildRunSummary(params: {
  available: number;
  refunded: number;
  totalCost: number;
}): WorkflowCreditsSummary {
  return {
    available: params.available,
    reserved: 0,
    totalCost: params.totalCost,
    used: Math.max(0, params.totalCost - params.refunded),
  };
}

async function getUserCreditBalance(executor: SelectExecutor, userId: string) {
  const [account] = await executor
    .select({ creditBalance: user.creditBalance })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!account) {
    throw new WorkflowInfrastructureError({
      message: `User ${userId} was not found.`,
    });
  }

  return account.creditBalance;
}

async function getExecutionTotals(
  executor: SelectExecutor,
  params: { executionId: string; userId: string },
) {
  const rows = await executor
    .select({
      amount: creditLedgerEntries.amount,
      kind: creditLedgerEntries.kind,
    })
    .from(creditLedgerEntries)
    .where(
      and(
        eq(creditLedgerEntries.executionId, params.executionId),
        eq(creditLedgerEntries.userId, params.userId),
      ),
    );

  return rows.reduce(
    (totals, row) => {
      if (row.kind === "debit") {
        totals.totalCost += row.amount;
      }

      if (row.kind === "refund") {
        totals.refunded += row.amount;
      }

      return totals;
    },
    { refunded: 0, totalCost: 0 },
  );
}

export class WorkflowCreditsService extends Context.Tag(
  "WorkflowCreditsService",
)<
  WorkflowCreditsService,
  {
    readonly debitExecutionOutput: (params: {
      amount: number;
      executionId: string;
      reason: string;
      sourceKey: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowCreditsSummary,
      WorkflowCreditsError | WorkflowInfrastructureError
    >;
    readonly getBalanceSummary: (
      userId: string,
    ) => Effect.Effect<WorkflowCreditsSummary, WorkflowInfrastructureError>;
    readonly getExecutionSummary: (params: {
      executionId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowCreditsSummary,
      WorkflowCreditsError | WorkflowInfrastructureError
    >;
  }
>() {
  static readonly toCreditsInfraError = (cause: unknown) => {
    if (cause instanceof WorkflowInfrastructureError) {
      return cause;
    }

    return new WorkflowInfrastructureError({
      message: getErrorMessage(cause),
      cause,
    });
  };

  static readonly toCreditsError = (cause: unknown) => {
    if (
      cause instanceof WorkflowCreditsError ||
      cause instanceof WorkflowInfrastructureError
    ) {
      return cause;
    }

    return new WorkflowInfrastructureError({
      message: getErrorMessage(cause),
      cause,
    });
  };

  static readonly Live = Layer.succeed(this, {
    debitExecutionOutput: ({
      amount,
      executionId,
      reason,
      sourceKey,
      userId,
    }) =>
      Effect.tryPromise({
        try: async () => {
          await syncSubscriptionCreditsForUser(userId);

          if (amount <= 0) {
            const available = await getUserCreditBalance(db, userId);
            const totals = await getExecutionTotals(db, {
              executionId,
              userId,
            });
            return buildRunSummary({
              available,
              refunded: totals.refunded,
              totalCost: totals.totalCost,
            });
          }

          return db.transaction(async (tx) => {
            const existing = await tx
              .select({ amount: creditLedgerEntries.amount })
              .from(creditLedgerEntries)
              .where(eq(creditLedgerEntries.sourceKey, sourceKey))
              .limit(1)
              .then((rows) => rows[0] ?? null);

            if (existing) {
              const [available, totals] = await Promise.all([
                getUserCreditBalance(tx, userId),
                getExecutionTotals(tx, { executionId, userId }),
              ]);
              return buildRunSummary({
                available,
                refunded: totals.refunded,
                totalCost: totals.totalCost,
              });
            }

            const now = new Date();
            const [updatedUser] = await tx
              .update(user)
              .set({
                creditBalance: sql`${user.creditBalance} - ${amount}`,
                updatedAt: now,
              })
              .where(and(eq(user.id, userId), gte(user.creditBalance, amount)))
              .returning({ creditBalance: user.creditBalance });

            if (!updatedUser) {
              throw new WorkflowCreditsError({
                message:
                  "You do not have enough credits to run this workflow output.",
              });
            }

            await tx.insert(creditLedgerEntries).values({
              amount,
              balanceAfter: updatedUser.creditBalance,
              createdAt: now,
              executionId,
              id: randomUUID(),
              kind: "debit",
              reason,
              sourceKey,
              userId,
            });

            const totals = await getExecutionTotals(tx, {
              executionId,
              userId,
            });
            return buildRunSummary({
              available: updatedUser.creditBalance,
              refunded: totals.refunded,
              totalCost: totals.totalCost,
            });
          });
        },
        catch: WorkflowCreditsService.toCreditsError,
      }),
    getBalanceSummary: (userId) =>
      Effect.tryPromise({
        try: async () => {
          await syncSubscriptionCreditsForUser(userId);
          return buildBalanceSummary(await getUserCreditBalance(db, userId));
        },
        catch: WorkflowCreditsService.toCreditsInfraError,
      }),
    getExecutionSummary: ({ executionId, userId }) =>
      Effect.tryPromise({
        try: async () => {
          const available = await getUserCreditBalance(db, userId);
          const totals = await getExecutionTotals(db, {
            executionId: executionId,
            userId,
          });

          return buildRunSummary({
            available,
            refunded: totals.refunded,
            totalCost: totals.totalCost,
          });
        },
        catch: WorkflowCreditsService.toCreditsError,
      }),
  });
}
