import { Context, type Effect } from "effect";
import type { BillingStripeError } from "~/features/billing/application/errors";

export class BillingPaymentGateway extends Context.Tag("BillingPaymentGateway")<
  BillingPaymentGateway,
  {
    readonly createCreditTopUpCheckoutUrl: (input: {
      readonly credits: number;
      readonly currency: string;
      readonly packPriceCents: number;
      readonly packSize: number;
      readonly packs: number;
      readonly stripeCustomerId: string;
      readonly userId: string;
    }) => Effect.Effect<string, BillingStripeError>;
    readonly createCustomer: (input: {
      readonly email: string;
      readonly name: string;
      readonly userId: string;
    }) => Effect.Effect<{ readonly id: string }, BillingStripeError>;
  }
>() {}
