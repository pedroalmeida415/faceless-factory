import { Layer } from "effect";
import { Billing } from "~/features/billing";

export const Features = Layer.mergeAll(Billing);
