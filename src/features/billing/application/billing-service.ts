import { Context, Data, Effect, Layer } from "effect";
import {
  BILLING_CURRENCY,
  type BillingSubscriptionRecord,
  CREDIT_TOP_UP_PACK_PRICE_CENTS,
  CREDIT_TOP_UP_PACK_SIZE,
  type CreditGrant,
  getSubscriptionCreditGrant,
  getSubscriptionGrantDates,
  getTopUpCreditGrant,
  type SuccessfulTopUpPayment,
} from "~/features/billing/domain/billing";

export class BillingDatabaseError extends Data.TaggedError("BillingDatabaseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class BillingStripeError extends Data.TaggedError("BillingStripeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class BillingUserNotFoundError extends Data.TaggedError("BillingUserNotFoundError")<{
  readonly message: string;
}> {}

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

export type BillingStoreApi = {
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
};

export class BillingStore extends Context.Tag("BillingStore")<BillingStore, BillingStoreApi>() {}

export type BillingPaymentGatewayApi = {
  readonly createCreditTopUpCheckoutUrl: (input: {
    readonly credits: number;
    readonly currency: string;
    readonly packPriceCents: number;
    readonly packSize: number;
    readonly packs: number;
    readonly stripeCustomerId: string;
    readonly userId: string;
  }) => Effect.Effect<string, BillingStripeError>;
  readonly createCustomer: (input: {
    readonly email: string;
    readonly name: string;
    readonly userId: string;
  }) => Effect.Effect<{ readonly id: string }, BillingStripeError>;
};

export class BillingPaymentGateway extends Context.Tag("BillingPaymentGateway")<
  BillingPaymentGateway,
  BillingPaymentGatewayApi
>() {}

export type BillingServiceApi = {
  readonly createCreditTopUpCheckoutSession: (params: {
    readonly packs: number;
    readonly userId: string;
  }) => Effect.Effect<string, BillingDatabaseError | BillingStripeError | BillingUserNotFoundError>;
  readonly getBillingOverview: (
    userId: string,
  ) => Effect.Effect<BillingOverview, BillingDatabaseError | BillingUserNotFoundError>;
  readonly handleSuccessfulTopUpPayment: (
    paymentIntent: SuccessfulTopUpPayment,
  ) => Effect.Effect<boolean, BillingDatabaseError | BillingUserNotFoundError>;
  readonly syncSubscriptionCredits: (
    subscriptionRecord: BillingSubscriptionRecord,
    now?: Date,
  ) => Effect.Effect<number, BillingDatabaseError | BillingUserNotFoundError>;
  readonly syncSubscriptionCreditsForUser: (
    userId: string,
  ) => Effect.Effect<number, BillingDatabaseError | BillingUserNotFoundError>;
};

export class BillingService extends Context.Tag("BillingService")<BillingService, BillingServiceApi>() {}

export const BillingServiceLive = Layer.effect(
  BillingService,
  Effect.gen(function* () {
    const store = yield* BillingStore;
    const paymentGateway = yield* BillingPaymentGateway;

    const applyCreditGrant = (grant: CreditGrant) => {
      if (grant.amount <= 0) {
        return Effect.succeed(false);
      }

      return store.applyCreditGrant(grant);
    };

    const ensureStripeCustomerId = (userId: string) =>
      Effect.gen(function* () {
        const account = yield* store.getUserRecord(userId);

        if (account.stripeCustomerId) {
          return account.stripeCustomerId;
        }

        const customer = yield* paymentGateway.createCustomer({
          email: account.email,
          name: account.name,
          userId,
        });

        yield* store.persistStripeCustomerId({
          stripeCustomerId: customer.id,
          userId,
        });

        return customer.id;
      });

    const syncSubscriptionCredits = (subscriptionRecord: BillingSubscriptionRecord, now = new Date()) => {
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

    const syncSubscriptionCreditsForUser = (userId: string) =>
      Effect.gen(function* () {
        const activeSubscription = yield* store.getActiveSubscription(userId);

        if (!activeSubscription) {
          return 0;
        }

        return yield* syncSubscriptionCredits(activeSubscription);
      });

    return BillingService.of({
      createCreditTopUpCheckoutSession: (params) =>
        Effect.gen(function* () {
          const stripeCustomerId = yield* ensureStripeCustomerId(params.userId);
          const credits = params.packs * CREDIT_TOP_UP_PACK_SIZE;

          return yield* paymentGateway.createCreditTopUpCheckoutUrl({
            credits,
            currency: BILLING_CURRENCY,
            packPriceCents: CREDIT_TOP_UP_PACK_PRICE_CENTS,
            packSize: CREDIT_TOP_UP_PACK_SIZE,
            packs: params.packs,
            stripeCustomerId,
            userId: params.userId,
          });
        }),
      getBillingOverview: (userId) =>
        Effect.gen(function* () {
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
        }),
      handleSuccessfulTopUpPayment: (paymentIntent) => {
        const grant = getTopUpCreditGrant(paymentIntent);
        return grant ? applyCreditGrant(grant) : Effect.succeed(false);
      },
      syncSubscriptionCredits,
      syncSubscriptionCreditsForUser,
    });
  }),
);
