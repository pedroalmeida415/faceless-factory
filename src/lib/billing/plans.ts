export const BILLING_PLAN_IDS = ["starter", "pro", "ultra"] as const;

export type BillingPlanId = (typeof BILLING_PLAN_IDS)[number];

export const BILLING_INTERVALS = ["month", "year"] as const;

export type BillingInterval = (typeof BILLING_INTERVALS)[number];

type BillingPlanPricing = Record<BillingInterval, number>;

type BillingPlanLookupKeys = Record<BillingInterval, string>;

export type BillingPlanDefinition = {
  id: BillingPlanId;
  name: string;
  description: string;
  pricingUsd: BillingPlanPricing;
  creditsPerMonth: number;
  stripeLookupKeys: BillingPlanLookupKeys;
};

const BILLING_PLAN_DEFINITIONS = {
  starter: {
    id: "starter",
    name: "Starter",
    description: "Ideal for solo creators shipping consistently.",
    pricingUsd: {
      month: 25,
      year: 19,
    },
    creditsPerMonth: 2_500,
    stripeLookupKeys: {
      month: "plan_starter_monthly",
      year: "plan_starter_annual",
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    description: "For teams running heavier daily generation workloads.",
    pricingUsd: {
      month: 50,
      year: 39,
    },
    creditsPerMonth: 5_000,
    stripeLookupKeys: {
      month: "plan_pro_monthly",
      year: "plan_pro_annual",
    },
  },
  ultra: {
    id: "ultra",
    name: "Ultra",
    description: "High-throughput plan for production media pipelines.",
    pricingUsd: {
      month: 200,
      year: 99,
    },
    creditsPerMonth: 20_000,
    stripeLookupKeys: {
      month: "plan_ultra_monthly",
      year: "plan_ultra_annual",
    },
  },
} as const satisfies Record<BillingPlanId, BillingPlanDefinition>;

export const BILLING_PLANS = BILLING_PLAN_IDS.map(
  (planId) => BILLING_PLAN_DEFINITIONS[planId],
);

export const CREDIT_TOP_UP = {
  credits: 1_000,
  lookupKey: "credits_top_up_1000",
  maxQuantity: 20,
  minQuantity: 1,
  unitAmountUsd: 10,
} as const;

export function isBillingPlanId(
  value: string | null | undefined,
): value is BillingPlanId {
  return (
    typeof value === "string" &&
    BILLING_PLAN_IDS.some((planId) => planId === value)
  );
}

export function toBillingInterval(
  value: string | null | undefined,
): BillingInterval {
  return value === "year" ? "year" : "month";
}

export function getPlanCreditsPerInterval(
  planId: string,
  billingInterval: BillingInterval,
) {
  if (!isBillingPlanId(planId)) {
    return null;
  }

  const monthlyCredits = BILLING_PLAN_DEFINITIONS[planId].creditsPerMonth;
  return billingInterval === "year" ? monthlyCredits * 12 : monthlyCredits;
}

export function getPlanByLookupKey(lookupKey: string | null | undefined) {
  if (!lookupKey) {
    return null;
  }

  for (const planId of BILLING_PLAN_IDS) {
    const plan = BILLING_PLAN_DEFINITIONS[planId];

    if (plan.stripeLookupKeys.month === lookupKey) {
      return {
        billingInterval: "month" as const,
        planId,
      };
    }

    if (plan.stripeLookupKeys.year === lookupKey) {
      return {
        billingInterval: "year" as const,
        planId,
      };
    }
  }

  return null;
}
