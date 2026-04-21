import { randomUUID } from "node:crypto";

import { and, eq, gte, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import {
  getErrorMessage,
  WorkflowCreditsError,
  WorkflowInfrastructureError,
} from "~/lib/workflow/errors";
import type { WorkflowCreditsSummary } from "~/lib/workflow/execution/types";
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
    readonly debitExecution: (params: {
      amount: number;
      executionId: string;
      reason: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowCreditsSummary,
      WorkflowCreditsError | WorkflowInfrastructureError
    >;
    readonly getBalanceSummary: (
      userId: string,
    ) => Effect.Effect<WorkflowCreditsSummary, WorkflowInfrastructureError>;
    readonly getRunSummary: (params: {
      runId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowCreditsSummary,
      WorkflowCreditsError | WorkflowInfrastructureError
    >;
    readonly refundExecution: (params: {
      executionId: string;
      reason: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowCreditsSummary,
      WorkflowCreditsError | WorkflowInfrastructureError
    >;
  }
>() {
  static readonly functions = Effect.serviceFunctions(this);

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
    debitExecution: ({ amount, executionId, reason, userId }) =>
      Effect.tryPromise({
        try: async () => {
          if (amount <= 0) {
            const available = await getUserCreditBalance(db, userId);
            return buildRunSummary({ available, refunded: 0, totalCost: 0 });
          }

          return db.transaction(async (tx) => {
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
                message: "You do not have enough credits to run this workflow.",
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
              userId,
            });

            return buildRunSummary({
              available: updatedUser.creditBalance,
              refunded: 0,
              totalCost: amount,
            });
          });
        },
        catch: WorkflowCreditsService.toCreditsError,
      }),
    getBalanceSummary: (userId) =>
      Effect.tryPromise({
        try: async () =>
          buildBalanceSummary(await getUserCreditBalance(db, userId)),
        catch: WorkflowCreditsService.toCreditsInfraError,
      }),
    getRunSummary: ({ runId, userId }) =>
      Effect.tryPromise({
        try: async () => {
          const available = await getUserCreditBalance(db, userId);
          const totals = await getExecutionTotals(db, {
            executionId: runId,
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
    refundExecution: ({ executionId, reason, userId }) =>
      Effect.tryPromise({
        try: async () =>
          db.transaction(async (tx) => {
            const totals = await getExecutionTotals(tx, {
              executionId,
              userId,
            });
            const refundableAmount = Math.max(
              0,
              totals.totalCost - totals.refunded,
            );

            if (refundableAmount <= 0) {
              return buildRunSummary({
                available: await getUserCreditBalance(tx, userId),
                refunded: totals.refunded,
                totalCost: totals.totalCost,
              });
            }

            const now = new Date();
            const [updatedUser] = await tx
              .update(user)
              .set({
                creditBalance: sql`${user.creditBalance} + ${refundableAmount}`,
                updatedAt: now,
              })
              .where(eq(user.id, userId))
              .returning({ creditBalance: user.creditBalance });

            if (!updatedUser) {
              throw new WorkflowInfrastructureError({
                message: `User ${userId} was not found.`,
              });
            }

            await tx.insert(creditLedgerEntries).values({
              amount: refundableAmount,
              balanceAfter: updatedUser.creditBalance,
              createdAt: now,
              executionId,
              id: randomUUID(),
              kind: "refund",
              reason,
              userId,
            });

            return buildRunSummary({
              available: updatedUser.creditBalance,
              refunded: totals.refunded + refundableAmount,
              totalCost: totals.totalCost,
            });
          }),
        catch: WorkflowCreditsService.toCreditsError,
      }),
  });
}
