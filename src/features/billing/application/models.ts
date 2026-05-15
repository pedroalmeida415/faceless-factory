import type { BillingSubscriptionRecord } from "~/features/billing/domain/billing";

export type BillingUserRecord = {
  readonly creditBalance: number;
  readonly email: string;
  readonly id: string;
  readonly name: string;
  readonly stripeCustomerId: string | null;
};

export type BillingOverview = {
  readonly activeSubscription: BillingSubscriptionRecord | null;
  readonly creditBalance: number;
  readonly latestSubscription: BillingSubscriptionRecord | null;
  readonly stripeCustomerId: string | null;
};
