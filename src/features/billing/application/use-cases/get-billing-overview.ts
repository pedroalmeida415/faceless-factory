import { Effect } from "effect";
import { BillingUserNotFoundError } from "~/features/billing/application/errors";
import { BillingStore } from "~/features/billing/application/store";
import { syncSubscriptionCreditsForUser } from "~/features/billing/application/use-cases/sync-subscription-credits-for-user";

export const getBillingOverview = (userId: string) =>
  Effect.gen(function* () {
    const store = yield* BillingStore;

    yield* syncSubscriptionCreditsForUser(userId);

    const { account, activeSubscription, latestSubscription } = yield* store.getBillingOverviewRecords(userId);

    if (!account) {
      return yield* Effect.fail(
        new BillingUserNotFoundError({
          message: `User ${userId} was not found.`,
        }),
      );
    }

    return {
      activeSubscription,
      creditBalance: account.creditBalance,
      latestSubscription,
      stripeCustomerId: account.stripeCustomerId,
    };
  });
