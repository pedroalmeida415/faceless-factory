import { stripeClient as betterAuthStripeClient } from "@better-auth/stripe/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [
    betterAuthStripeClient({
      subscription: true,
    }),
  ],
});

export type Session = typeof authClient.$Infer.Session;
