import { Layer } from "effect";
import { BillingServiceLive } from "~/features/billing/application/billing-service";
import { BillingStoreLive } from "~/features/billing/infra/persistence";
import { BillingPaymentGatewayLive } from "~/features/billing/infra/stripe";

export const Billing = BillingServiceLive.pipe(
  Layer.provide(Layer.mergeAll(BillingStoreLive, BillingPaymentGatewayLive)),
);
