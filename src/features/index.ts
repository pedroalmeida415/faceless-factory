import { Layer } from "effect";
import { BillingService } from "~/features/billing/service";

export const Features = Layer.mergeAll(BillingService.Live);
