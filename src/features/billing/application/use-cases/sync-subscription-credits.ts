import { Effect } from "effect";
import { applyCreditGrant } from "~/features/billing/application/use-cases/apply-credit-grant";
import {
  type BillingSubscriptionRecord,
  getSubscriptionCreditGrant,
  getSubscriptionGrantDates,
} from "~/features/billing/domain/billing";

export const syncSubscriptionCredits = (subscriptionRecord: BillingSubscriptionRecord, now = new Date()) => {
  const grants = getSubscriptionGrantDates(subscriptionRecord, now).flatMap((grantDate) => {
    const grant = getSubscriptionCreditGrant({
      grantDate,
      subscription: subscriptionRecord,
    });

    return grant ? [grant] : [];
  });

  return Effect.map(Effect.forEach(grants, applyCreditGrant, { concurrency: 1 }), (appliedGrants) =>
    appliedGrants.reduce((total, applied, index) => (applied ? total + (grants[index]?.amount ?? 0) : total), 0),
  );
};
