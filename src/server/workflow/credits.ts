import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { WorkflowCreditsSummary } from "~/lib/billing";
import {
  getErrorMessage,
  WorkflowInfrastructureError,
} from "~/lib/workflow/errors";
import { syncSubscriptionCreditsForUser } from "~/server/billing/service";
import { db } from "~/server/db";
import { user } from "~/server/db/schema";

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

export class WorkflowCreditsService extends Context.Tag(
  "WorkflowCreditsService",
)<
  WorkflowCreditsService,
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
        catch: WorkflowCreditsService.toCreditsInfraError,
      }),
  });
}
