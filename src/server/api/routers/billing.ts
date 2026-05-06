import { z } from "zod";
import { auth } from "~/features/auth/server/config";
import { BILLING_PLAN_NAMES } from "~/features/billing/billing";
import {
  createCreditTopUpCheckoutSession,
  getBillingOverview,
} from "~/features/billing/server/service";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const billingRouter = createTRPCRouter({
  createBillingPortalSession: protectedProcedure.mutation(async ({ ctx }) =>
    auth.api.createBillingPortal({
      body: {
        disableRedirect: true,
        returnUrl: "/app/billing",
      },
      headers: ctx.headers,
    }),
  ),

  createSubscriptionCheckoutSession: protectedProcedure
    .input(
      z.object({
        annual: z.boolean(),
        plan: z.enum(BILLING_PLAN_NAMES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const overview = await getBillingOverview(ctx.session.user.id);

      return auth.api.upgradeSubscription({
        body: {
          annual: input.annual,
          cancelUrl: "/app/billing",
          disableRedirect: true,
          plan: input.plan,
          returnUrl: "/app/billing",
          subscriptionId:
            overview.activeSubscription?.stripeSubscriptionId ?? undefined,
          successUrl: "/app/billing?checkout=success",
        },
        headers: ctx.headers,
      });
    }),

  createTopUpCheckoutSession: protectedProcedure
    .input(
      z.object({
        packs: z.number().int().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => ({
      url: await createCreditTopUpCheckoutSession({
        packs: input.packs,
        userId: ctx.session.user.id,
      }),
    })),

  getOverview: protectedProcedure.query(async ({ ctx }) =>
    getBillingOverview(ctx.session.user.id),
  ),
});
