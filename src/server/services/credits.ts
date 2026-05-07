import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { WorkflowCreditsSummary } from "~/features/billing/billing";
import { syncSubscriptionCreditsForUser } from "~/features/billing/server/service";
import {
  getErrorMessage,
  WorkflowInfrastructureError,
} from "~/features/workflow/errors";
import { user } from "~/server/database/schema";
import { DatabaseService } from "~/server/services/database";

function buildBalanceSummary(available: number): WorkflowCreditsSummary {
  return {
    available,
    totalCost: 0,
    used: 0,
  };
}

function toCreditsInfraError(cause: unknown) {
  if (cause instanceof WorkflowInfrastructureError) {
    return cause;
  }

  return new WorkflowInfrastructureError({
    message: getErrorMessage(cause),
    cause,
  });
}

function getUserCreditBalance(userId: string) {
  return Effect.gen(function* () {
    const database = yield* DatabaseService;
    const [account] = yield* Effect.mapError(
      database.run(
        Effect.gen(function* () {
          const db = yield* PgDrizzle.PgDrizzle;
          return yield* db
            .select({ creditBalance: user.creditBalance })
            .from(user)
            .where(eq(user.id, userId))
            .limit(1);
        }),
      ),
      toCreditsInfraError,
    );

    if (!account) {
      return yield* Effect.fail(
        new WorkflowInfrastructureError({
          message: `User ${userId} was not found.`,
        }),
      );
    }

    return account.creditBalance;
  });
}

export class CreditsService extends Context.Tag("CreditsService")<
  CreditsService,
  {
    readonly getBalanceSummary: (
      userId: string,
    ) => Effect.Effect<WorkflowCreditsSummary, WorkflowInfrastructureError>;
  }
>() {
  static readonly Live = Layer.effect(
    this,
    Effect.map(DatabaseService, (database) => ({
      getBalanceSummary: (userId) =>
        Effect.gen(function* () {
          yield* Effect.mapError(
            Effect.provideService(
              syncSubscriptionCreditsForUser(userId),
              DatabaseService,
              database,
            ),
            toCreditsInfraError,
          );
          const balance = yield* Effect.provideService(
            getUserCreditBalance(userId),
            DatabaseService,
            database,
          );
          return buildBalanceSummary(balance);
        }),
    })),
  );
}
