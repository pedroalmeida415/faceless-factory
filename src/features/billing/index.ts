import { Layer } from "effect";
import { BillingStoreLive } from "~/features/billing/infra/store";
import { BillingPaymentGatewayLive } from "~/features/billing/infra/stripe";

export const Billing = Layer.mergeAll(BillingStoreLive, BillingPaymentGatewayLive);
