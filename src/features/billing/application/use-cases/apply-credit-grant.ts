import { Effect } from "effect";
import { BillingStore } from "~/features/billing/application/store";
import type { CreditGrant } from "~/features/billing/domain/billing";

export const applyCreditGrant = (grant: CreditGrant) => {
  if (grant.amount <= 0) {
    return Effect.succeed(false);
  }

  return Effect.gen(function* () {
    const store = yield* BillingStore;

    return yield* store.applyCreditGrant(grant);
  });
};
