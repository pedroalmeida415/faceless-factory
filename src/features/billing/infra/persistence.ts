import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { DatabaseService } from "~/core/application/database-service";
import {
  BillingDatabaseError,
  BillingStore,
  BillingUserNotFoundError,
} from "~/features/billing/application/billing-service";
import { creditLedgerEntries, subscription, user } from "~/main/database/schema";

export const BillingStoreLive = Layer.effect(
  BillingStore,
  Effect.gen(function* () {
    const database = yield* DatabaseService;

    return BillingStore.of({
      applyCreditGrant: (grant) => {
        if (grant.amount <= 0) {
          return Effect.succeed(false);
        }

        return mapBillingDatabaseError(
          database.sql.withTransaction(
            Effect.gen(function* () {
              const now = new Date();

              const [existingLedgerEntry] = yield* database
                .select({ id: creditLedgerEntries.id })
                .from(creditLedgerEntries)
                .where(eq(creditLedgerEntries.sourceKey, grant.sourceKey))
                .limit(1);

              if (existingLedgerEntry) {
                return false;
              }

              const [existingUser] = yield* database
                .select({ id: user.id })
                .from(user)
                .where(eq(user.id, grant.userId))
                .limit(1);

              if (!existingUser) {
                return yield* Effect.fail(
                  new BillingUserNotFoundError({
                    message: `User ${grant.userId} was not found.`,
                  }),
                );
              }

              const [ledgerEntry] = yield* database
                .insert(creditLedgerEntries)
                .values({
                  amount: grant.amount,
                  balanceAfter: 0,
                  createdAt: now,
                  id: randomUUID(),
                  kind: grant.kind,
                  reason: grant.reason,
                  sourceKey: grant.sourceKey,
                  userId: grant.userId,
                })
                .onConflictDoNothing({ target: creditLedgerEntries.sourceKey })
                .returning({ id: creditLedgerEntries.id });

              if (!ledgerEntry) {
                return false;
              }

              const [updatedUser] = yield* database
                .update(user)
                .set({
                  creditBalance: sql`${user.creditBalance} + ${grant.amount}`,
                  updatedAt: now,
                })
                .where(eq(user.id, grant.userId))
                .returning({ creditBalance: user.creditBalance });

              if (!updatedUser) {
                return yield* Effect.fail(
                  new BillingUserNotFoundError({
                    message: `User ${grant.userId} was not found.`,
                  }),
                );
              }

              yield* database
                .update(creditLedgerEntries)
                .set({ balanceAfter: updatedUser.creditBalance })
                .where(eq(creditLedgerEntries.id, ledgerEntry.id));

              return true;
            }),
          ),
          "Failed to apply credit grant.",
        );
      },
      getActiveSubscription: (userId) =>
        mapBillingDatabaseError(
          Effect.map(
            database
              .select()
              .from(subscription)
              .where(and(eq(subscription.referenceId, userId), inArray(subscription.status, ["active", "trialing"])))
              .orderBy(desc(subscription.periodEnd))
              .limit(1),
            ([activeSubscription]) => activeSubscription ?? null,
          ),
          "Failed to load active billing subscription.",
        ),
      getBillingOverviewRecords: (userId) =>
        mapBillingDatabaseError(
          Effect.gen(function* () {
            const [account] = yield* database
              .select({
                creditBalance: user.creditBalance,
                stripeCustomerId: user.stripeCustomerId,
              })
              .from(user)
              .where(eq(user.id, userId))
              .limit(1);
            const [activeSubscription] = yield* database
              .select()
              .from(subscription)
              .where(and(eq(subscription.referenceId, userId), inArray(subscription.status, ["active", "trialing"])))
              .orderBy(desc(subscription.periodEnd))
              .limit(1);
            const [latestSubscription] = yield* database
              .select()
              .from(subscription)
              .where(eq(subscription.referenceId, userId))
              .orderBy(desc(subscription.periodEnd))
              .limit(1);

            return {
              account: account ?? null,
              activeSubscription: activeSubscription ?? null,
              latestSubscription: latestSubscription ?? null,
            };
          }),
          "Failed to load billing overview.",
        ),
      getUserRecord: (userId) =>
        Effect.gen(function* () {
          const [account] = yield* mapBillingDatabaseError(
            database
              .select({
                creditBalance: user.creditBalance,
                email: user.email,
                id: user.id,
                name: user.name,
                stripeCustomerId: user.stripeCustomerId,
              })
              .from(user)
              .where(eq(user.id, userId))
              .limit(1),
            "Failed to load billing user.",
          );

          if (!account) {
            return yield* Effect.fail(
              new BillingUserNotFoundError({
                message: `User ${userId} was not found.`,
              }),
            );
          }

          return account;
        }),
      persistStripeCustomerId: (input) =>
        Effect.gen(function* () {
          const [updatedUser] = yield* mapBillingDatabaseError(
            database
              .update(user)
              .set({
                stripeCustomerId: input.stripeCustomerId,
                updatedAt: new Date(),
              })
              .where(eq(user.id, input.userId))
              .returning({ id: user.id }),
            "Failed to persist Stripe customer id.",
          );

          if (!updatedUser) {
            return yield* Effect.fail(
              new BillingUserNotFoundError({
                message: `User ${input.userId} was not found.`,
              }),
            );
          }
        }),
    });
  }),
);

function mapBillingDatabaseError<A, E>(effect: Effect.Effect<A, E>, failureMessage: string) {
  return Effect.mapError(effect, (cause) =>
    isBillingDomainError(cause) ? cause : new BillingDatabaseError({ message: failureMessage, cause }),
  );
}

function isBillingDomainError(cause: unknown): cause is BillingUserNotFoundError {
  return typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "BillingUserNotFoundError";
}
