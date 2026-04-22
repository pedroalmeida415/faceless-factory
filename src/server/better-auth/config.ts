import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";

import { env } from "~/env";
import { BILLING_PLANS } from "~/lib/billing/plans";
import { handleStripeEvent } from "~/server/billing/stripe-events";
import { db } from "~/server/db";
import { stripeClient } from "~/server/stripe/client";

const subscriptionPlans = BILLING_PLANS.map((plan) => ({
  annualDiscountLookupKey: plan.stripeLookupKeys.year,
  limits: {
    credits: plan.creditsPerMonth,
  },
  lookupKey: plan.stripeLookupKeys.month,
  name: plan.id,
}));

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, {
    provider: "pg", // or "pg" or "mysql"
  }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    github: {
      clientId: env.BETTER_AUTH_GITHUB_CLIENT_ID,
      clientSecret: env.BETTER_AUTH_GITHUB_CLIENT_SECRET,
      redirectURI: `${env.BETTER_AUTH_URL}/api/auth/callback/github`,
    },
  },
  // Make sure nextCookies() is the last plugin in the array
  plugins: [
    stripe({
      createCustomerOnSignUp: true,
      onEvent: handleStripeEvent,
      stripeClient,
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
      subscription: {
        enabled: true,
        plans: subscriptionPlans,
      },
    }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
