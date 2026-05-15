import { Effect } from "effect";
import { BillingPaymentGateway } from "~/features/billing/application/payment-gateway";
import { BillingStore } from "~/features/billing/application/store";
import {
  BILLING_CURRENCY,
  CREDIT_TOP_UP_PACK_PRICE_CENTS,
  CREDIT_TOP_UP_PACK_SIZE,
} from "~/features/billing/domain/billing";

export const createCreditTopUpCheckoutSession = (params: { readonly packs: number; readonly userId: string }) =>
  Effect.gen(function* () {
    const store = yield* BillingStore;
    const paymentGateway = yield* BillingPaymentGateway;
    const account = yield* store.getUserRecord(params.userId);
    const stripeCustomerId = account.stripeCustomerId
      ? account.stripeCustomerId
      : yield* Effect.gen(function* () {
          const customer = yield* paymentGateway.createCustomer({
            email: account.email,
            name: account.name,
            userId: params.userId,
          });

          yield* store.persistStripeCustomerId({
            stripeCustomerId: customer.id,
            userId: params.userId,
          });

          return customer.id;
        });
    const credits = params.packs * CREDIT_TOP_UP_PACK_SIZE;

    return yield* paymentGateway.createCreditTopUpCheckoutUrl({
      credits,
      currency: BILLING_CURRENCY,
      packPriceCents: CREDIT_TOP_UP_PACK_PRICE_CENTS,
      packSize: CREDIT_TOP_UP_PACK_SIZE,
      packs: params.packs,
      stripeCustomerId,
      userId: params.userId,
    });
  });
