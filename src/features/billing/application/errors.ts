import { Data } from "effect";

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
