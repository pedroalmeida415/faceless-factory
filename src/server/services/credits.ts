import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { WorkflowCreditsSummary } from "~/features/billing/billing";
import { syncSubscriptionCreditsForUser } from "~/features/billing/server/service";
import {
  getErrorMessage,
  WorkflowInfrastructureError,
} from "~/features/workflow/errors";
import { user } from "~/server/database/schema";
import { db } from "~/server/services/database";

type SelectExecutor = Pick<typeof db, "select">;

function buildBalanceSummary(available: number): WorkflowCreditsSummary {
  return {
    available,
    totalCost: 0,
    used: 0,
  };
}

async function getUserCreditBalance(executor: SelectExecutor, userId: string) {
  const [account] = await executor
    .select({ creditBalance: user.creditBalance })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!account) {
    throw new WorkflowInfrastructureError({
      message: `User ${userId} was not found.`,
    });
  }

  return account.creditBalance;
}

export class CreditsService extends Context.Tag("CreditsService")<
  CreditsService,
  {
    readonly getBalanceSummary: (
      userId: string,
    ) => Effect.Effect<WorkflowCreditsSummary, WorkflowInfrastructureError>;
  }
>() {
  static readonly toCreditsInfraError = (cause: unknown) => {
    if (cause instanceof WorkflowInfrastructureError) {
      return cause;
    }

    return new WorkflowInfrastructureError({
      message: getErrorMessage(cause),
      cause,
    });
  };

  static readonly Live = Layer.succeed(this, {
    getBalanceSummary: (userId) =>
      Effect.tryPromise({
        try: async () => {
          await syncSubscriptionCreditsForUser(userId);
          return buildBalanceSummary(await getUserCreditBalance(db, userId));
        },
        catch: CreditsService.toCreditsInfraError,
      }),
  });
}
