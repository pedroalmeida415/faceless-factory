import { Layer } from "effect";
import { Billing } from "~/features/billing";
import { Workflow } from "~/features/workflow";

export const Features = Layer.mergeAll(Billing, Workflow);
