import { Effect } from "effect";
import { applyCreditGrant } from "~/features/billing/application/use-cases/apply-credit-grant";
import { getTopUpCreditGrant, type SuccessfulTopUpPayment } from "~/features/billing/domain/billing";

export const handleSuccessfulTopUpPayment = (paymentIntent: SuccessfulTopUpPayment) => {
  const grant = getTopUpCreditGrant(paymentIntent);

  return grant ? applyCreditGrant(grant) : Effect.succeed(false);
};
