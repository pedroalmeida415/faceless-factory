import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";

import { env } from "~/env";
import { BILLING_PLANS } from "~/features/billing/billing";
import {
  handleSuccessfulTopUpPayment,
  syncSubscriptionCredits,
} from "~/features/billing/server/service";
import { ServerRuntime } from "~/server/effect";
import { db } from "~/server/services/database";
import { stripeClient } from "~/server/services/stripe";

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
      getCustomerCreateParams: async (user) => ({
        metadata: {
          app: "faceless-factory",
          userId: user.id,
        },
      }),
      onEvent: async (event) => {
        if (event.type !== "payment_intent.succeeded") {
          return;
        }

        await ServerRuntime.runPromise(
          handleSuccessfulTopUpPayment(event.data.object),
        );
      },
      stripeClient,
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
      subscription: {
        authorizeReference: async ({ referenceId, user }) =>
          referenceId === user.id,
        enabled: true,
        onSubscriptionComplete: async ({ subscription }) => {
          await ServerRuntime.runPromise(syncSubscriptionCredits(subscription));
        },
        onSubscriptionCreated: async ({ subscription }) => {
          await ServerRuntime.runPromise(syncSubscriptionCredits(subscription));
        },
        onSubscriptionUpdate: async ({ subscription }) => {
          await ServerRuntime.runPromise(syncSubscriptionCredits(subscription));
        },
        plans: BILLING_PLANS.map((plan) => ({
          annualDiscountLookupKey: plan.annualPriceLookupKey,
          limits: {
            monthlyCredits: plan.creditsPerMonth,
          },
          lookupKey: plan.monthlyPriceLookupKey,
          name: plan.name,
        })),
      },
    }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
