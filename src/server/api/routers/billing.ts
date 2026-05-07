import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { auth } from "~/features/auth/server/config";
import { BILLING_PLAN_NAMES } from "~/features/billing/billing";
import {
  BillingDatabaseError,
  BillingStripeError,
  BillingUserNotFoundError,
  createCreditTopUpCheckoutSession,
  getBillingOverview,
} from "~/features/billing/server/service";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { ServerRuntime } from "~/server/effect";

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
      const overview = await ServerRuntime.runPromise(
        getBillingOverview(ctx.session.user.id),
      ).catch((error: unknown) => {
        throw toBillingTRPCError(error);
      });

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
      url: await ServerRuntime.runPromise(
        createCreditTopUpCheckoutSession({
          packs: input.packs,
          userId: ctx.session.user.id,
        }),
      ).catch((error: unknown) => {
        throw toBillingTRPCError(error);
      }),
    })),

  getOverview: protectedProcedure.query(async ({ ctx }) =>
    ServerRuntime.runPromise(getBillingOverview(ctx.session.user.id)).catch(
      (error: unknown) => {
        throw toBillingTRPCError(error);
      },
    ),
  ),
});

function toBillingTRPCError(error: unknown) {
  if (error instanceof BillingUserNotFoundError) {
    return new TRPCError({ code: "NOT_FOUND", message: error.message });
  }

  if (
    error instanceof BillingDatabaseError ||
    error instanceof BillingStripeError
  ) {
    return new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: error.message,
    });
  }

  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Billing workflow failed.",
  });
}
