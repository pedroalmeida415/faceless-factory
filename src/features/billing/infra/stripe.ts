import Stripe from "stripe";

import { env } from "~/env";

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
