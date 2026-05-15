import { Context, type Effect } from "effect";
import type { BillingDatabaseError, BillingUserNotFoundError } from "~/features/billing/application/errors";
import type { BillingUserRecord } from "~/features/billing/application/models";
import type { BillingSubscriptionRecord, CreditGrant } from "~/features/billing/domain/billing";

export class BillingStore extends Context.Tag("BillingStore")<
  BillingStore,
  {
    readonly applyCreditGrant: (
      grant: CreditGrant,
    ) => Effect.Effect<boolean, BillingDatabaseError | BillingUserNotFoundError>;
    readonly getActiveSubscription: (
      userId: string,
    ) => Effect.Effect<BillingSubscriptionRecord | null, BillingDatabaseError>;
    readonly getBillingOverviewRecords: (userId: string) => Effect.Effect<
      {
        readonly account: Pick<BillingUserRecord, "creditBalance" | "stripeCustomerId"> | null;
        readonly activeSubscription: BillingSubscriptionRecord | null;
        readonly latestSubscription: BillingSubscriptionRecord | null;
      },
      BillingDatabaseError
    >;
    readonly getUserRecord: (
      userId: string,
    ) => Effect.Effect<BillingUserRecord, BillingDatabaseError | BillingUserNotFoundError>;
    readonly persistStripeCustomerId: (input: {
      readonly stripeCustomerId: string;
      readonly userId: string;
    }) => Effect.Effect<void, BillingDatabaseError | BillingUserNotFoundError>;
  }
>() {}
