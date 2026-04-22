import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { env } from "~/env";
import { CREDIT_TOP_UP, toBillingInterval } from "~/lib/billing/plans";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { STRIPE_TOP_UP_METADATA_KIND } from "~/server/billing/stripe-events";
import { subscription, user } from "~/server/db/schema";
import { stripeClient } from "~/server/stripe/client";
import { getStripePriceIdByLookupKey } from "~/server/stripe/prices";

const ACTIVE_OR_PENDING_SUBSCRIPTION_STATUSES = [
  "active",
  "incomplete",
  "past_due",
  "trialing",
] as const;

export const billingRouter = createTRPCRouter({
  createTopUpCheckout: protectedProcedure
    .input(
      z
        .object({
          quantity: z
            .number()
            .int()
            .min(CREDIT_TOP_UP.minQuantity)
            .max(CREDIT_TOP_UP.maxQuantity),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const quantity = input?.quantity ?? 1;
      const [billingUser] = await ctx.db
        .select({
          email: user.email,
          stripeCustomerId: user.stripeCustomerId,
        })
        .from(user)
        .where(eq(user.id, ctx.session.user.id))
        .limit(1);

      if (!billingUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found for billing checkout.",
        });
      }

      const topUpPriceId = await getStripePriceIdByLookupKey(
        CREDIT_TOP_UP.lookupKey,
      );
      const checkoutSession = await stripeClient.checkout.sessions.create({
        allow_promotion_codes: true,
        cancel_url: `${env.BETTER_AUTH_URL}/app/billing?topup=cancel`,
        customer: billingUser.stripeCustomerId ?? undefined,
        customer_email: billingUser.stripeCustomerId
          ? undefined
          : billingUser.email,
        line_items: [
          {
            price: topUpPriceId,
            quantity,
          },
        ],
        metadata: {
          kind: STRIPE_TOP_UP_METADATA_KIND,
          quantity: String(quantity),
          userId: ctx.session.user.id,
        },
        mode: "payment",
        success_url: `${env.BETTER_AUTH_URL}/app/billing?topup=success`,
      });

      if (!checkoutSession.url) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Stripe checkout did not return a redirect URL.",
        });
      }

      return { url: checkoutSession.url };
    }),

  currentSubscription: protectedProcedure.query(async ({ ctx }) => {
    const [activeSubscription] = await ctx.db
      .select({
        billingInterval: subscription.billingInterval,
        periodEnd: subscription.periodEnd,
        plan: subscription.plan,
        status: subscription.status,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
      })
      .from(subscription)
      .where(
        and(
          eq(subscription.referenceId, ctx.session.user.id),
          inArray(subscription.status, ACTIVE_OR_PENDING_SUBSCRIPTION_STATUSES),
        ),
      )
      .orderBy(desc(subscription.periodEnd))
      .limit(1);

    if (!activeSubscription) {
      return null;
    }

    return {
      billingInterval: toBillingInterval(activeSubscription.billingInterval),
      periodEnd: activeSubscription.periodEnd?.toISOString() ?? null,
      plan: activeSubscription.plan,
      status: activeSubscription.status,
      stripeSubscriptionId: activeSubscription.stripeSubscriptionId,
    };
  }),
});
