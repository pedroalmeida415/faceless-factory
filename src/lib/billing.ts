export type BillingPlanName = "starter" | "plus" | "ultra";
export type BillingInterval = "month" | "year";

export type WorkflowCreditsSummary = {
  available: number;
  used: number;
  totalCost: number;
};

type BillingPlanDefinition = {
  readonly annualPriceCents: number;
  readonly annualPriceLookupKey: string;
  readonly creditsPerMonth: number;
  readonly description: string;
  readonly featured?: boolean;
  readonly monthlyPriceCents: number;
  readonly monthlyPriceLookupKey: string;
  readonly name: BillingPlanName;
  readonly title: string;
};

export const CREDIT_TOP_UP_PACK_PRICE_CENTS = 1_000;
export const CREDIT_TOP_UP_PACK_SIZE = 1_000;
export const BILLING_CURRENCY = "usd";

export const BILLING_PLANS = [
  {
    annualPriceCents: 22_800,
    annualPriceLookupKey: "faceless-factory-starter-annual",
    creditsPerMonth: 1_500,
    description: "For solo creators getting their first workflow stack live.",
    featured: false,
    monthlyPriceCents: 2_500,
    monthlyPriceLookupKey: "faceless-factory-starter-monthly",
    name: "starter",
    title: "Starter",
  },
  {
    annualPriceCents: 46_800,
    annualPriceLookupKey: "faceless-factory-plus-annual",
    creditsPerMonth: 4_500,
    description: "For teams that need faster iteration without tier-hopping.",
    featured: true,
    monthlyPriceCents: 5_000,
    monthlyPriceLookupKey: "faceless-factory-plus-monthly",
    name: "plus",
    title: "Plus",
  },
  {
    annualPriceCents: 118_800,
    annualPriceLookupKey: "faceless-factory-ultra-annual",
    creditsPerMonth: 20_000,
    description:
      "For high-volume production where credits must stay ahead of demand.",
    featured: false,
    monthlyPriceCents: 20_000,
    monthlyPriceLookupKey: "faceless-factory-ultra-monthly",
    name: "ultra",
    title: "Ultra",
  },
] as const satisfies readonly BillingPlanDefinition[];

export const BILLING_PLAN_NAMES = BILLING_PLANS.map((plan) => plan.name) as [
  BillingPlanName,
  ...BillingPlanName[],
];

export function formatUsd(cents: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(cents / 100);
}

export function getBillingPlan(planName: string) {
  return BILLING_PLANS.find((plan) => plan.name === planName) ?? null;
}

export function getBillingPlanCredits(planName: string) {
  return getBillingPlan(planName)?.creditsPerMonth ?? 0;
}

export function getBillingPlanLookupKey(
  planName: BillingPlanName,
  interval: BillingInterval,
) {
  const plan = getBillingPlan(planName);

  if (!plan) {
    return null;
  }

  return interval === "year"
    ? plan.annualPriceLookupKey
    : plan.monthlyPriceLookupKey;
}

export function isBillingPlanName(value: string): value is BillingPlanName {
  return BILLING_PLANS.some((plan) => plan.name === value);
}
