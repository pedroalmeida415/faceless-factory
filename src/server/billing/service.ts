import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type Stripe from "stripe";

import {
  BILLING_CURRENCY,
  CREDIT_TOP_UP_PACK_PRICE_CENTS,
  CREDIT_TOP_UP_PACK_SIZE,
  getBillingPlan,
} from "~/lib/billing";
import { getAbsoluteUrl, stripeClient } from "~/server/billing/stripe";
import { db } from "~/server/db";
import { creditLedgerEntries, subscription, user } from "~/server/db/schema";

type BillingSubscriptionRecord = {
  id: string;
  plan: string;
  referenceId: string;
  status: string;
  periodEnd?: Date | null;
  periodStart?: Date | null;
};

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

async function getUserCreditBalance(
  executor: Pick<typeof db, "select">,
  userId: string,
) {
  const [account] = await executor
    .select({ creditBalance: user.creditBalance })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  return account?.creditBalance ?? 0;
}

async function applyCreditGrant(params: {
  amount: number;
  kind: "grant" | "purchase";
  reason: string;
  sourceKey: string;
  userId: string;
}) {
  if (params.amount <= 0) {
    return false;
  }

  const result = await db.transaction(async (tx) => {
    const now = new Date();
    const [ledgerEntry] = await tx
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

    const [updatedUser] = await tx
      .update(user)
      .set({
        creditBalance: sql`${user.creditBalance} + ${params.amount}`,
        updatedAt: now,
      })
      .where(eq(user.id, params.userId))
      .returning({ creditBalance: user.creditBalance });

    if (!updatedUser) {
      throw new Error(`User ${params.userId} was not found.`);
    }

    await tx
      .update(creditLedgerEntries)
      .set({ balanceAfter: updatedUser.creditBalance })
      .where(eq(creditLedgerEntries.id, ledgerEntry.id));

    return true;
  });

  return result;
}

async function getUserRecord(userId: string) {
  const [account] = await db
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

  if (!account) {
    throw new Error(`User ${userId} was not found.`);
  }

  return account;
}

export async function ensureStripeCustomerId(userId: string) {
  const account = await getUserRecord(userId);

  if (account.stripeCustomerId) {
    return account.stripeCustomerId;
  }

  const customer = await stripeClient.customers.create({
    email: account.email,
    metadata: {
      app: "faceless-factory",
      userId,
    },
    name: account.name,
  });

  await db
    .update(user)
    .set({
      stripeCustomerId: customer.id,
      updatedAt: new Date(),
    })
    .where(eq(user.id, userId));

  return customer.id;
}

export async function syncSubscriptionCredits(
  subscriptionRecord: BillingSubscriptionRecord,
  now = new Date(),
) {
  const plan = getBillingPlan(subscriptionRecord.plan);

  if (!plan) {
    return 0;
  }

  let grantedCredits = 0;

  for (const grantDate of getSubscriptionGrantDates(subscriptionRecord, now)) {
    const applied = await applyCreditGrant({
      amount: plan.creditsPerMonth,
      kind: "grant",
      reason: getSubscriptionGrantReason(subscriptionRecord.plan),
      sourceKey: getSubscriptionGrantSourceKey(
        subscriptionRecord.id,
        grantDate,
      ),
      userId: subscriptionRecord.referenceId,
    });

    if (applied) {
      grantedCredits += plan.creditsPerMonth;
    }
  }

  return grantedCredits;
}

export async function syncSubscriptionCreditsForUser(userId: string) {
  const [activeSubscription] = await db
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

  if (!activeSubscription) {
    return 0;
  }

  return syncSubscriptionCredits(activeSubscription);
}

export async function handleSuccessfulTopUpPayment(
  paymentIntent: Stripe.PaymentIntent,
) {
  const credits = Number(paymentIntent.metadata.credits ?? "0");
  const userId = paymentIntent.metadata.userId;

  if (
    paymentIntent.metadata.billingType !== "credit-topup" ||
    !userId ||
    credits <= 0
  ) {
    return false;
  }

  return applyCreditGrant({
    amount: credits,
    kind: "purchase",
    reason: `Credit top-up (${credits.toLocaleString()} credits)`,
    sourceKey: `payment-intent:${paymentIntent.id}`,
    userId,
  });
}

export async function createCreditTopUpCheckoutSession(params: {
  packs: number;
  userId: string;
}) {
  const stripeCustomerId = await ensureStripeCustomerId(params.userId);
  const credits = params.packs * CREDIT_TOP_UP_PACK_SIZE;

  const session = await stripeClient.checkout.sessions.create({
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
  });

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL.");
  }

  return session.url;
}

export async function getBillingOverview(userId: string) {
  await syncSubscriptionCreditsForUser(userId);

  const [account, activeSubscription, latestSubscription] = await Promise.all([
    getUserRecord(userId),
    db
      .select()
      .from(subscription)
      .where(
        and(
          eq(subscription.referenceId, userId),
          inArray(subscription.status, ["active", "trialing"]),
        ),
      )
      .orderBy(desc(subscription.periodEnd))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select()
      .from(subscription)
      .where(eq(subscription.referenceId, userId))
      .orderBy(desc(subscription.periodEnd))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  return {
    activeSubscription,
    creditBalance: await getUserCreditBalance(db, userId),
    latestSubscription,
    stripeCustomerId: account.stripeCustomerId,
  };
}
