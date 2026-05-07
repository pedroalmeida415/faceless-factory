import { randomUUID } from "node:crypto";

import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type Context, Data, Effect } from "effect";
import type Stripe from "stripe";

import {
  BILLING_CURRENCY,
  CREDIT_TOP_UP_PACK_PRICE_CENTS,
  CREDIT_TOP_UP_PACK_SIZE,
  getBillingPlan,
} from "~/features/billing/billing";
import {
  creditLedgerEntries,
  subscription,
  user,
} from "~/server/database/schema";
import { DatabaseService } from "~/server/services/database";
import { getAbsoluteUrl, stripeClient } from "~/server/services/stripe";

export class BillingDatabaseError extends Data.TaggedError(
  "BillingDatabaseError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class BillingStripeError extends Data.TaggedError("BillingStripeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class BillingUserNotFoundError extends Data.TaggedError(
  "BillingUserNotFoundError",
)<{
  readonly message: string;
}> {}

type BillingSubscriptionRecord = {
  id: string;
  plan: string;
  referenceId: string;
  status: string;
  periodEnd?: Date | null;
  periodStart?: Date | null;
};

type SuccessfulTopUpPayment = Pick<Stripe.PaymentIntent, "id" | "metadata">;

function addMonthsClamped(date: Date, months: number) {
  const monthIndex = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDayOfMonth = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(date.getUTCDate(), lastDayOfMonth),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

function getSubscriptionGrantDates(
  subscriptionRecord: BillingSubscriptionRecord,
  now: Date,
) {
  if (
    !subscriptionRecord.periodStart ||
    !subscriptionRecord.periodEnd ||
    !["active", "trialing"].includes(subscriptionRecord.status)
  ) {
    return [];
  }

  const grantDates: Date[] = [];
  let monthOffset = 0;

  while (true) {
    const grantDate = addMonthsClamped(
      subscriptionRecord.periodStart,
      monthOffset,
    );

    if (
      grantDate.getTime() >= subscriptionRecord.periodEnd.getTime() ||
      grantDate.getTime() > now.getTime()
    ) {
      return grantDates;
    }

    grantDates.push(grantDate);
    monthOffset += 1;
  }
}

function getSubscriptionGrantReason(planName: string) {
  const plan = getBillingPlan(planName);
  return `${plan?.title ?? planName} subscription credits`;
}

function getSubscriptionGrantSourceKey(
  subscriptionId: string,
  grantDate: Date,
) {
  return `subscription:${subscriptionId}:${grantDate.toISOString()}`;
}

function isBillingDomainError(
  cause: unknown,
): cause is BillingUserNotFoundError {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "BillingUserNotFoundError"
  );
}

function toBillingDatabaseError(message: string) {
  return (cause: unknown) =>
    isBillingDomainError(cause)
      ? cause
      : new BillingDatabaseError({ message, cause });
}

function runBillingQuery<A, E>(
  database: Context.Tag.Service<typeof DatabaseService>,
  effect: Effect.Effect<A, E, PgDrizzle.PgDrizzle>,
  failureMessage: string,
) {
  return Effect.mapError(
    database.run(effect),
    toBillingDatabaseError(failureMessage),
  );
}

function applyCreditGrant(params: {
  amount: number;
  kind: "grant" | "purchase";
  reason: string;
  sourceKey: string;
  userId: string;
}) {
  if (params.amount <= 0) {
    return Effect.succeed(false);
  }

  return Effect.gen(function* () {
    const database = yield* DatabaseService;

    return yield* Effect.mapError(
      database.transaction(
        Effect.gen(function* () {
          const db = yield* PgDrizzle.PgDrizzle;
          const now = new Date();

          const [existingLedgerEntry] = yield* db
            .select({ id: creditLedgerEntries.id })
            .from(creditLedgerEntries)
            .where(eq(creditLedgerEntries.sourceKey, params.sourceKey))
            .limit(1);

          if (existingLedgerEntry) {
            return false;
          }

          const [existingUser] = yield* db
            .select({ id: user.id })
            .from(user)
            .where(eq(user.id, params.userId))
            .limit(1);

          if (!existingUser) {
            return yield* Effect.fail(
              new BillingUserNotFoundError({
                message: `User ${params.userId} was not found.`,
              }),
            );
          }

          const [ledgerEntry] = yield* db
            .insert(creditLedgerEntries)
            .values({
              amount: params.amount,
              balanceAfter: 0,
              createdAt: now,
              executionId: null,
              id: randomUUID(),
              kind: params.kind,
              reason: params.reason,
              sourceKey: params.sourceKey,
              userId: params.userId,
            })
            .onConflictDoNothing({ target: creditLedgerEntries.sourceKey })
            .returning({ id: creditLedgerEntries.id });

          if (!ledgerEntry) {
            return false;
          }

          const [updatedUser] = yield* db
            .update(user)
            .set({
              creditBalance: sql`${user.creditBalance} + ${params.amount}`,
              updatedAt: now,
            })
            .where(eq(user.id, params.userId))
            .returning({ creditBalance: user.creditBalance });

          if (!updatedUser) {
            return yield* Effect.fail(
              new BillingUserNotFoundError({
                message: `User ${params.userId} was not found.`,
              }),
            );
          }

          yield* db
            .update(creditLedgerEntries)
            .set({ balanceAfter: updatedUser.creditBalance })
            .where(eq(creditLedgerEntries.id, ledgerEntry.id));

          return true;
        }),
      ),
      toBillingDatabaseError("Failed to apply credit grant."),
    );
  });
}

function getUserRecord(userId: string) {
  return Effect.gen(function* () {
    const database = yield* DatabaseService;
    const [account] = yield* runBillingQuery(
      database,
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle;
        return yield* db
          .select({
            creditBalance: user.creditBalance,
            email: user.email,
            id: user.id,
            name: user.name,
            stripeCustomerId: user.stripeCustomerId,
          })
          .from(user)
          .where(eq(user.id, userId))
          .limit(1);
      }),
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
  });
}

export function ensureStripeCustomerId(userId: string) {
  return Effect.gen(function* () {
    const account = yield* getUserRecord(userId);

    if (account.stripeCustomerId) {
      return account.stripeCustomerId;
    }

    const customer = yield* Effect.tryPromise({
      try: () =>
        stripeClient.customers.create({
          email: account.email,
          metadata: {
            app: "faceless-factory",
            userId,
          },
          name: account.name,
        }),
      catch: (cause) =>
        new BillingStripeError({
          message: "Failed to create Stripe customer.",
          cause,
        }),
    });

    const database = yield* DatabaseService;
    const [updatedUser] = yield* runBillingQuery(
      database,
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle;
        return yield* db
          .update(user)
          .set({
            stripeCustomerId: customer.id,
            updatedAt: new Date(),
          })
          .where(eq(user.id, userId))
          .returning({ id: user.id });
      }),
      "Failed to persist Stripe customer id.",
    );

    if (!updatedUser) {
      return yield* Effect.fail(
        new BillingUserNotFoundError({
          message: `User ${userId} was not found.`,
        }),
      );
    }

    return customer.id;
  });
}

export function syncSubscriptionCredits(
  subscriptionRecord: BillingSubscriptionRecord,
  now = new Date(),
) {
  const plan = getBillingPlan(subscriptionRecord.plan);

  if (!plan) {
    return Effect.succeed(0);
  }

  return Effect.map(
    Effect.forEach(
      getSubscriptionGrantDates(subscriptionRecord, now),
      (grantDate) =>
        applyCreditGrant({
          amount: plan.creditsPerMonth,
          kind: "grant",
          reason: getSubscriptionGrantReason(subscriptionRecord.plan),
          sourceKey: getSubscriptionGrantSourceKey(
            subscriptionRecord.id,
            grantDate,
          ),
          userId: subscriptionRecord.referenceId,
        }),
      { concurrency: 1 },
    ),
    (appliedGrants) =>
      appliedGrants.filter(Boolean).length * plan.creditsPerMonth,
  );
}

export function syncSubscriptionCreditsForUser(userId: string) {
  return Effect.gen(function* () {
    const database = yield* DatabaseService;
    const [activeSubscription] = yield* runBillingQuery(
      database,
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle;
        return yield* db
          .select()
          .from(subscription)
          .where(
            and(
              eq(subscription.referenceId, userId),
              inArray(subscription.status, ["active", "trialing"]),
            ),
          )
          .orderBy(desc(subscription.periodEnd))
          .limit(1);
      }),
      "Failed to load active billing subscription.",
    );

    if (!activeSubscription) {
      return 0;
    }

    return yield* syncSubscriptionCredits(activeSubscription);
  });
}

export function handleSuccessfulTopUpPayment(
  paymentIntent: SuccessfulTopUpPayment,
) {
  const credits = Number(paymentIntent.metadata.credits ?? "0");
  const userId = paymentIntent.metadata.userId;

  if (
    paymentIntent.metadata.billingType !== "credit-topup" ||
    !userId ||
    credits <= 0
  ) {
    return Effect.succeed(false);
  }

  return applyCreditGrant({
    amount: credits,
    kind: "purchase",
    reason: `Credit top-up (${credits.toLocaleString()} credits)`,
    sourceKey: `payment-intent:${paymentIntent.id}`,
    userId,
  });
}

export function createCreditTopUpCheckoutSession(params: {
  packs: number;
  userId: string;
}) {
  return Effect.gen(function* () {
    const stripeCustomerId = yield* ensureStripeCustomerId(params.userId);
    const credits = params.packs * CREDIT_TOP_UP_PACK_SIZE;

    const session = yield* Effect.tryPromise({
      try: () =>
        stripeClient.checkout.sessions.create({
          cancel_url: getAbsoluteUrl("/app/billing"),
          customer: stripeCustomerId,
          line_items: [
            {
              price_data: {
                currency: BILLING_CURRENCY,
                product_data: {
                  description: `${CREDIT_TOP_UP_PACK_SIZE.toLocaleString()} credits per pack`,
                  name: "Faceless Factory credit top-up",
                },
                unit_amount: CREDIT_TOP_UP_PACK_PRICE_CENTS,
              },
              quantity: params.packs,
            },
          ],
          metadata: {
            billingType: "credit-topup",
            credits: String(credits),
            packs: String(params.packs),
            userId: params.userId,
          },
          mode: "payment",
          payment_intent_data: {
            metadata: {
              billingType: "credit-topup",
              credits: String(credits),
              packs: String(params.packs),
              userId: params.userId,
            },
          },
          success_url: getAbsoluteUrl("/app/billing?checkout=success"),
        }),
      catch: (cause) =>
        new BillingStripeError({
          message: "Failed to create credit top-up checkout session.",
          cause,
        }),
    });

    if (!session.url) {
      return yield* Effect.fail(
        new BillingStripeError({
          message: "Stripe did not return a checkout URL.",
        }),
      );
    }

    return session.url;
  });
}

export function getBillingOverview(userId: string) {
  return Effect.gen(function* () {
    yield* syncSubscriptionCreditsForUser(userId);

    const database = yield* DatabaseService;
    const { account, activeSubscription, latestSubscription } =
      yield* runBillingQuery(
        database,
        Effect.gen(function* () {
          const db = yield* PgDrizzle.PgDrizzle;
          const [account] = yield* db
            .select({
              creditBalance: user.creditBalance,
              stripeCustomerId: user.stripeCustomerId,
            })
            .from(user)
            .where(eq(user.id, userId))
            .limit(1);
          const [activeSubscription] = yield* db
            .select()
            .from(subscription)
            .where(
              and(
                eq(subscription.referenceId, userId),
                inArray(subscription.status, ["active", "trialing"]),
              ),
            )
            .orderBy(desc(subscription.periodEnd))
            .limit(1);
          const [latestSubscription] = yield* db
            .select()
            .from(subscription)
            .where(eq(subscription.referenceId, userId))
            .orderBy(desc(subscription.periodEnd))
            .limit(1);

          return {
            account,
            activeSubscription: activeSubscription ?? null,
            latestSubscription: latestSubscription ?? null,
          };
        }),
        "Failed to load billing overview.",
      );

    if (!account) {
      return yield* Effect.fail(
        new BillingUserNotFoundError({
          message: `User ${userId} was not found.`,
        }),
      );
    }

    return {
      activeSubscription,
      creditBalance: account.creditBalance,
      latestSubscription,
      stripeCustomerId: account.stripeCustomerId,
    };
  });
}
