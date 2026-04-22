import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type Stripe from "stripe";
import { ServerRuntime } from "~/effect/server/runtime";
import {
  CREDIT_TOP_UP,
  getPlanByLookupKey,
  getPlanCreditsPerInterval,
  toBillingInterval,
} from "~/lib/billing/plans";
import { db } from "~/server/db";
import { subscription, user } from "~/server/db/schema";
import { stripeClient } from "~/server/stripe/client";
import { WorkflowCreditsService } from "~/server/workflow/credits";

const SUBSCRIPTION_CREDIT_BILLING_REASONS = new Set([
  "subscription_create",
  "subscription_cycle",
]);

export const STRIPE_TOP_UP_METADATA_KIND = "credit-top-up";

async function creditUserAccount(params: {
  amount: number;
  kind: "grant" | "purchase";
  reason: string;
  referenceId: string;
  userId: string;
}) {
  await ServerRuntime.runPromise(
    Effect.gen(function* () {
      const workflowCreditsService = yield* WorkflowCreditsService;
      return yield* workflowCreditsService.creditAccount(params);
    }),
  );
}

function parseTopUpQuantity(rawQuantity: string | null | undefined) {
  const quantity = Number(rawQuantity);

  if (!Number.isInteger(quantity)) {
    return null;
  }

  if (
    quantity < CREDIT_TOP_UP.minQuantity ||
    quantity > CREDIT_TOP_UP.maxQuantity
  ) {
    return null;
  }

  return quantity;
}

async function resolveSubscriptionCreditTarget(params: {
  invoice: Stripe.Invoice;
  stripeSubscriptionId: string;
}) {
  const [activeSubscription] = await db
    .select({
      billingInterval: subscription.billingInterval,
      plan: subscription.plan,
      referenceId: subscription.referenceId,
    })
    .from(subscription)
    .where(eq(subscription.stripeSubscriptionId, params.stripeSubscriptionId))
    .limit(1);

  if (activeSubscription) {
    return {
      billingInterval: toBillingInterval(activeSubscription.billingInterval),
      plan: activeSubscription.plan,
      userId: activeSubscription.referenceId,
    };
  }

  const stripeCustomerId =
    typeof params.invoice.customer === "string"
      ? params.invoice.customer
      : (params.invoice.customer?.id ?? null);

  if (!stripeCustomerId) {
    return null;
  }

  const [billingUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.stripeCustomerId, stripeCustomerId))
    .limit(1);

  if (!billingUser) {
    return null;
  }

  const stripeSubscription = await stripeClient.subscriptions.retrieve(
    params.stripeSubscriptionId,
    {
      expand: ["items.data.price"],
    },
  );
  const primaryPrice = stripeSubscription.items.data[0]?.price;
  const lookupKey =
    typeof primaryPrice === "string" ? null : primaryPrice?.lookup_key;
  const planMatch = getPlanByLookupKey(lookupKey);

  if (!planMatch) {
    return null;
  }

  return {
    billingInterval: planMatch.billingInterval,
    plan: planMatch.planId,
    userId: billingUser.id,
  };
}

async function handleInvoicePaid(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const invoiceSubscription =
    invoice.parent?.subscription_details?.subscription;
  const stripeSubscriptionId =
    typeof invoiceSubscription === "string"
      ? invoiceSubscription
      : (invoiceSubscription?.id ?? null);

  if (!stripeSubscriptionId) {
    return;
  }

  const billingReason = invoice.billing_reason ?? "";
  if (!SUBSCRIPTION_CREDIT_BILLING_REASONS.has(billingReason)) {
    return;
  }

  const creditTarget = await resolveSubscriptionCreditTarget({
    invoice,
    stripeSubscriptionId,
  });

  if (!creditTarget) {
    return;
  }

  const credits = getPlanCreditsPerInterval(
    creditTarget.plan,
    creditTarget.billingInterval,
  );

  if (!credits) {
    return;
  }

  await creditUserAccount({
    amount: credits,
    kind: "grant",
    reason: `${creditTarget.plan} ${creditTarget.billingInterval} subscription credits`,
    referenceId: `stripe:invoice:${invoice.id}`,
    userId: creditTarget.userId,
  });
}

async function handleCheckoutSessionCompleted(event: Stripe.Event) {
  const checkoutSession = event.data.object as Stripe.Checkout.Session;

  if (
    checkoutSession.mode !== "payment" ||
    checkoutSession.payment_status !== "paid"
  ) {
    return;
  }

  if (checkoutSession.metadata?.kind !== STRIPE_TOP_UP_METADATA_KIND) {
    return;
  }

  const quantity = parseTopUpQuantity(checkoutSession.metadata.quantity);
  const userId = checkoutSession.metadata.userId;
  if (!quantity || !userId) {
    return;
  }

  await creditUserAccount({
    amount: quantity * CREDIT_TOP_UP.credits,
    kind: "purchase",
    reason: `Stripe credit top-up (${quantity} x ${CREDIT_TOP_UP.credits})`,
    referenceId: `stripe:checkout:${checkoutSession.id}`,
    userId,
  });
}

export async function handleStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutSessionCompleted(event);
      return;
    case "invoice.paid":
      await handleInvoicePaid(event);
      return;
    default:
      return;
  }
}
