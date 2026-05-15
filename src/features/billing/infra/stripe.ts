import { Effect, Layer } from "effect";
import Stripe from "stripe";

import { env } from "~/env";
import { BillingStripeError } from "~/features/billing/application/errors";
import { BillingPaymentGateway } from "~/features/billing/application/payment-gateway";

const globalForStripe = globalThis as unknown as {
  stripe: Stripe | undefined;
};

export const stripeClient =
  globalForStripe.stripe ??
  new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-03-25.dahlia",
  });

if (env.NODE_ENV !== "production") {
  globalForStripe.stripe = stripeClient;
}

export function getAbsoluteUrl(path: string) {
  return new URL(path, env.BETTER_AUTH_URL).toString();
}

export const BillingPaymentGatewayLive = Layer.succeed(
  BillingPaymentGateway,
  BillingPaymentGateway.of({
    createCreditTopUpCheckoutUrl: (input) =>
      Effect.gen(function* () {
        const session = yield* Effect.tryPromise({
          try: () =>
            stripeClient.checkout.sessions.create({
              cancel_url: getAbsoluteUrl("/app/billing"),
              customer: input.stripeCustomerId,
              line_items: [
                {
                  price_data: {
                    currency: input.currency,
                    product_data: {
                      description: `${input.packSize.toLocaleString()} credits per pack`,
                      name: "Faceless Factory credit top-up",
                    },
                    unit_amount: input.packPriceCents,
                  },
                  quantity: input.packs,
                },
              ],
              metadata: {
                billingType: "credit-topup",
                credits: String(input.credits),
                packs: String(input.packs),
                userId: input.userId,
              },
              mode: "payment",
              payment_intent_data: {
                metadata: {
                  billingType: "credit-topup",
                  credits: String(input.credits),
                  packs: String(input.packs),
                  userId: input.userId,
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
      }),
    createCustomer: (input) =>
      Effect.tryPromise({
        try: () =>
          stripeClient.customers.create({
            email: input.email,
            metadata: {
              app: "faceless-factory",
              userId: input.userId,
            },
            name: input.name,
          }),
        catch: (cause) =>
          new BillingStripeError({
            message: "Failed to create Stripe customer.",
            cause,
          }),
      }),
  }),
);
