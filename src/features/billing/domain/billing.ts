export type BillingPlanName = "starter" | "plus" | "ultra";
export type BillingInterval = "month" | "year";

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

export type BillingSubscriptionRecord = {
  readonly id: string;
  readonly plan: string;
  readonly referenceId: string;
  readonly status: string;
  readonly periodEnd?: Date | null;
  readonly periodStart?: Date | null;
};

export type CreditGrant = {
  readonly amount: number;
  readonly kind: "grant" | "purchase";
  readonly reason: string;
  readonly sourceKey: string;
  readonly userId: string;
};

export type SuccessfulTopUpPayment = {
  readonly id: string;
  readonly metadata: Readonly<Record<string, string>>;
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

export function getSubscriptionGrantDates(
  subscriptionRecord: BillingSubscriptionRecord,
  now: Date,
) {
  if (
    !subscriptionRecord.periodStart ||
    !subscriptionRecord.periodEnd ||
    !["active", "trialing"].includes(subscriptionRecord.status)
  ) {
    return [];
  }

  const grantDates: Date[] = [];
  let monthOffset = 0;

  while (true) {
    const grantDate = addMonthsClamped(
      subscriptionRecord.periodStart,
      monthOffset,
    );

    if (
      grantDate.getTime() >= subscriptionRecord.periodEnd.getTime() ||
      grantDate.getTime() > now.getTime()
    ) {
      return grantDates;
    }

    grantDates.push(grantDate);
    monthOffset += 1;
  }
}

export function getSubscriptionCreditGrant(input: {
  readonly grantDate: Date;
  readonly subscription: BillingSubscriptionRecord;
}): CreditGrant | null {
  const plan = getBillingPlan(input.subscription.plan);

  if (!plan) {
    return null;
  }

  return {
    amount: plan.creditsPerMonth,
    kind: "grant",
    reason: `${plan.title} subscription credits`,
    sourceKey: `subscription:${input.subscription.id}:${input.grantDate.toISOString()}`,
    userId: input.subscription.referenceId,
  };
}

export function getTopUpCreditGrant(
  paymentIntent: SuccessfulTopUpPayment,
): CreditGrant | null {
  const credits = Number(paymentIntent.metadata.credits ?? "0");
  const userId = paymentIntent.metadata.userId;

  if (
    paymentIntent.metadata.billingType !== "credit-topup" ||
    !userId ||
    credits <= 0
  ) {
    return null;
  }

  return {
    amount: credits,
    kind: "purchase",
    reason: `Credit top-up (${credits.toLocaleString()} credits)`,
    sourceKey: `payment-intent:${paymentIntent.id}`,
    userId,
  };
}

function addMonthsClamped(date: Date, months: number) {
  const monthIndex = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDayOfMonth = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(date.getUTCDate(), lastDayOfMonth),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}
