import "server-only";

import { Context, Effect, Layer } from "effect";

import { WorkflowCreditsError } from "~/lib/workflow/errors";
import type { WorkflowCreditsSummary } from "~/lib/workflow/execution/types";

const DEFAULT_AVAILABLE_CREDITS = 500;

type WorkflowCreditsAccount = {
  granted: number;
  spent: number;
};

type WorkflowCreditsReservation = {
  runId: string;
  userId: string;
  totalCost: number;
  reserved: number;
  used: number;
};

const accountsByUserId = new Map<string, WorkflowCreditsAccount>();
const reservationsByRunId = new Map<string, WorkflowCreditsReservation>();

function getOrCreateAccount(userId: string) {
  const existing = accountsByUserId.get(userId);
  if (existing) {
    return existing;
  }

  const nextAccount: WorkflowCreditsAccount = {
    granted: DEFAULT_AVAILABLE_CREDITS,
    spent: 0,
  };
  accountsByUserId.set(userId, nextAccount);
  return nextAccount;
}

function getReservedCreditsForUser(userId: string) {
  let totalReserved = 0;

  for (const reservation of reservationsByRunId.values()) {
    if (reservation.userId === userId) {
      totalReserved += reservation.reserved;
    }
  }

  return totalReserved;
}

function getAvailableCredits(userId: string) {
  const account = getOrCreateAccount(userId);
  return Math.max(
    0,
    account.granted - account.spent - getReservedCreditsForUser(userId),
  );
}

function buildBalanceSummary(userId: string): WorkflowCreditsSummary {
  return {
    available: getAvailableCredits(userId),
    reserved: getReservedCreditsForUser(userId),
    used: 0,
    totalCost: 0,
  };
}

function getReservation(runId: string, userId: string) {
  const reservation = reservationsByRunId.get(runId);
  if (!reservation || reservation.userId !== userId) {
    throw new WorkflowCreditsError({
      message: `Credits reservation for run ${runId} was not found.`,
    });
  }

  return reservation;
}

function buildRunSummary(
  reservation: WorkflowCreditsReservation,
): WorkflowCreditsSummary {
  return {
    available: getAvailableCredits(reservation.userId),
    reserved: reservation.reserved,
    used: reservation.used,
    totalCost: reservation.totalCost,
  };
}

export class WorkflowCreditsService extends Context.Tag(
  "WorkflowCreditsService",
)<
  WorkflowCreditsService,
  {
    readonly getBalanceSummary: (
      userId: string,
    ) => Effect.Effect<WorkflowCreditsSummary>;
    readonly getRunSummary: (params: {
      runId: string;
      userId: string;
    }) => Effect.Effect<WorkflowCreditsSummary, WorkflowCreditsError>;
    readonly reserveCredits: (params: {
      runId: string;
      userId: string;
      totalCost: number;
    }) => Effect.Effect<WorkflowCreditsSummary, WorkflowCreditsError>;
    readonly consumeReservedCredits: (params: {
      runId: string;
      userId: string;
      cost: number;
    }) => Effect.Effect<WorkflowCreditsSummary, WorkflowCreditsError>;
    readonly finalizeReservation: (params: {
      runId: string;
      userId: string;
    }) => Effect.Effect<WorkflowCreditsSummary, WorkflowCreditsError>;
    readonly refundRemainingCredits: (params: {
      runId: string;
      userId: string;
    }) => Effect.Effect<WorkflowCreditsSummary, WorkflowCreditsError>;
  }
>() {
  static readonly functions = Effect.serviceFunctions(this);

  static readonly Live = Layer.succeed(this, {
    getBalanceSummary: (userId) =>
      Effect.sync(() => buildBalanceSummary(userId)),
    getRunSummary: ({ runId, userId }) =>
      Effect.sync(() => buildRunSummary(getReservation(runId, userId))),
    reserveCredits: ({ runId, userId, totalCost }) =>
      Effect.sync(() => {
        const existingReservation = reservationsByRunId.get(runId);
        if (existingReservation) {
          if (existingReservation.userId !== userId) {
            throw new WorkflowCreditsError({
              message: `Run ${runId} is already reserved for another user.`,
            });
          }

          return buildRunSummary(existingReservation);
        }

        if (getAvailableCredits(userId) < totalCost) {
          throw new WorkflowCreditsError({
            message: "You do not have enough credits to run this workflow.",
          });
        }

        const reservation: WorkflowCreditsReservation = {
          runId,
          userId,
          totalCost,
          reserved: totalCost,
          used: 0,
        };
        reservationsByRunId.set(runId, reservation);

        return buildRunSummary(reservation);
      }),
    consumeReservedCredits: ({ runId, userId, cost }) =>
      Effect.sync(() => {
        const reservation = getReservation(runId, userId);

        if (cost <= 0) {
          return buildRunSummary(reservation);
        }

        if (reservation.reserved < cost) {
          throw new WorkflowCreditsError({
            message: "Run exceeded its reserved credits.",
          });
        }

        const account = getOrCreateAccount(userId);
        reservation.reserved -= cost;
        reservation.used += cost;
        account.spent += cost;

        return buildRunSummary(reservation);
      }),
    finalizeReservation: ({ runId, userId }) =>
      Effect.sync(() => {
        const reservation = getReservation(runId, userId);
        reservation.reserved = 0;
        return buildRunSummary(reservation);
      }),
    refundRemainingCredits: ({ runId, userId }) =>
      Effect.sync(() => {
        const reservation = getReservation(runId, userId);
        reservation.reserved = 0;
        return buildRunSummary(reservation);
      }),
  });
}
