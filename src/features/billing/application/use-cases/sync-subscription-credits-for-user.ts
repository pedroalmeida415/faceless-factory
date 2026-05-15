import { Effect } from "effect";
import { BillingStore } from "~/features/billing/application/store";
import { syncSubscriptionCredits } from "~/features/billing/application/use-cases/sync-subscription-credits";

export const syncSubscriptionCreditsForUser = (userId: string) =>
  Effect.gen(function* () {
    const store = yield* BillingStore;
    const activeSubscription = yield* store.getActiveSubscription(userId);

    if (!activeSubscription) {
      return 0;
    }

    return yield* syncSubscriptionCredits(activeSubscription);
  });
