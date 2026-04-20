import { Context, Effect, Layer } from "effect";

import {
  getErrorMessage,
  WorkflowCreditsError,
  WorkflowInfrastructureError,
} from "~/lib/workflow/errors";
import type { WorkflowCreditsSummary } from "~/lib/workflow/execution/types";
import { getRedisClient } from "~/server/redis";

const DEFAULT_AVAILABLE_CREDITS = 500;
const WORKFLOW_RESERVATION_TTL_SECONDS = 60 * 60 * 24;

type WorkflowCreditsAccount = {
  granted: number;
  reserved: number;
  spent: number;
};

type WorkflowCreditsReservation = {
  runId: string;
  userId: string;
  totalCost: number;
  reserved: number;
  used: number;
};

type WorkflowCreditsMutationResult = {
  available: number;
  reserved: number;
  status: "ok" | "run-conflict" | "insufficient" | "not-found";
  totalCost: number;
  used: number;
};

function getWorkflowCreditsAccountKey(userId: string) {
  return `workflow:credits:account:${userId}`;
}

function getWorkflowCreditsReservationKey(runId: string) {
  return `workflow:credits:reservation:${runId}`;
}

function parseStoredNumber(value: string | undefined, fallback: number) {
  return value ? Number(value) : fallback;
}

async function getOrCreateAccount(userId: string) {
  const client = await getRedisClient();
  const accountKey = getWorkflowCreditsAccountKey(userId);
  const storedAccount = await client.hGetAll(accountKey);

  if (Object.keys(storedAccount).length) {
    return {
      granted: parseStoredNumber(
        storedAccount.granted,
        DEFAULT_AVAILABLE_CREDITS,
      ),
      reserved: parseStoredNumber(storedAccount.reserved, 0),
      spent: parseStoredNumber(storedAccount.spent, 0),
    } satisfies WorkflowCreditsAccount;
  }

  const nextAccount: WorkflowCreditsAccount = {
    granted: DEFAULT_AVAILABLE_CREDITS,
    reserved: 0,
    spent: 0,
  };

  await client.hSet(accountKey, {
    granted: String(nextAccount.granted),
    reserved: String(nextAccount.reserved),
    spent: String(nextAccount.spent),
  });

  return nextAccount;
}

async function getReservation(runId: string, userId: string) {
  const client = await getRedisClient();
  const storedReservation = await client.hGetAll(
    getWorkflowCreditsReservationKey(runId),
  );

  if (
    !Object.keys(storedReservation).length ||
    storedReservation.userId !== userId
  ) {
    throw new WorkflowCreditsError({
      message: `Credits reservation for run ${runId} was not found.`,
    });
  }

  return {
    runId: storedReservation.runId ?? runId,
    totalCost: parseStoredNumber(storedReservation.totalCost, 0),
    reserved: parseStoredNumber(storedReservation.reserved, 0),
    used: parseStoredNumber(storedReservation.used, 0),
    userId: storedReservation.userId,
  } satisfies WorkflowCreditsReservation;
}

function buildBalanceSummary(
  account: WorkflowCreditsAccount,
): WorkflowCreditsSummary {
  return {
    available: Math.max(0, account.granted - account.spent - account.reserved),
    reserved: account.reserved,
    used: 0,
    totalCost: 0,
  };
}

function buildRunSummary(
  result: Pick<
    WorkflowCreditsMutationResult,
    "available" | "reserved" | "totalCost" | "used"
  >,
): WorkflowCreditsSummary {
  return {
    available: result.available,
    reserved: result.reserved,
    used: result.used,
    totalCost: result.totalCost,
  };
}

function getMutationResultScript() {
  return `
local reservationKey = KEYS[1]
local accountKey = KEYS[2]
local runId = ARGV[1]
local userId = ARGV[2]
local amount = tonumber(ARGV[3])
local ttlSeconds = tonumber(ARGV[4])
local action = ARGV[5]

local granted = tonumber(redis.call('HGET', accountKey, 'granted') or '${DEFAULT_AVAILABLE_CREDITS}')
local spent = tonumber(redis.call('HGET', accountKey, 'spent') or '0')
local accountReserved = tonumber(redis.call('HGET', accountKey, 'reserved') or '0')

redis.call('HSET', accountKey, 'granted', granted, 'spent', spent, 'reserved', accountReserved)

local reservationUserId = redis.call('HGET', reservationKey, 'userId')
local totalCost = tonumber(redis.call('HGET', reservationKey, 'totalCost') or tostring(amount))
local reservationReserved = tonumber(redis.call('HGET', reservationKey, 'reserved') or '0')
local reservationUsed = tonumber(redis.call('HGET', reservationKey, 'used') or '0')

if action == 'reserve' then
  if reservationUserId then
    if reservationUserId ~= userId then
      return cjson.encode({ status = 'run-conflict' })
    end

    return cjson.encode({
      status = 'ok',
      available = math.max(0, granted - spent - accountReserved),
      reserved = reservationReserved,
      totalCost = totalCost,
      used = reservationUsed,
    })
  end

  local available = granted - spent - accountReserved
  if available < amount then
    return cjson.encode({ status = 'insufficient' })
  end

  reservationReserved = amount
  reservationUsed = 0
  totalCost = amount
  accountReserved = accountReserved + amount

  redis.call('HSET', accountKey, 'reserved', accountReserved)
  redis.call(
    'HSET',
    reservationKey,
    'runId', runId,
    'userId', userId,
    'totalCost', totalCost,
    'reserved', reservationReserved,
    'used', reservationUsed
  )
  redis.call('EXPIRE', reservationKey, ttlSeconds)

  return cjson.encode({
    status = 'ok',
    available = math.max(0, granted - spent - accountReserved),
    reserved = reservationReserved,
    totalCost = totalCost,
    used = reservationUsed,
  })
end

if not reservationUserId or reservationUserId ~= userId then
  return cjson.encode({ status = 'not-found' })
end

if action == 'consume' then
  if amount > reservationReserved then
    return cjson.encode({ status = 'insufficient' })
  end

  reservationReserved = reservationReserved - amount
  reservationUsed = reservationUsed + amount
  spent = spent + amount
  accountReserved = accountReserved - amount

  redis.call('HSET', accountKey, 'spent', spent, 'reserved', accountReserved)
  redis.call('HSET', reservationKey, 'reserved', reservationReserved, 'used', reservationUsed)
  redis.call('EXPIRE', reservationKey, ttlSeconds)

  return cjson.encode({
    status = 'ok',
    available = math.max(0, granted - spent - accountReserved),
    reserved = reservationReserved,
    totalCost = totalCost,
    used = reservationUsed,
  })
end

if action == 'finalize' or action == 'refund' then
  accountReserved = math.max(0, accountReserved - reservationReserved)
  reservationReserved = 0

  redis.call('HSET', accountKey, 'reserved', accountReserved)
  redis.call('HSET', reservationKey, 'reserved', reservationReserved)
  redis.call('EXPIRE', reservationKey, ttlSeconds)

  return cjson.encode({
    status = 'ok',
    available = math.max(0, granted - spent - accountReserved),
    reserved = reservationReserved,
    totalCost = totalCost,
    used = reservationUsed,
  })
end

return cjson.encode({ status = 'not-found' })
`;
}

async function mutateReservation(params: {
  action: "consume" | "finalize" | "refund" | "reserve";
  amount: number;
  runId: string;
  userId: string;
}) {
  const client = await getRedisClient();
  const result = (await client.eval(getMutationResultScript(), {
    arguments: [
      params.runId,
      params.userId,
      String(params.amount),
      String(WORKFLOW_RESERVATION_TTL_SECONDS),
      params.action,
    ],
    keys: [
      getWorkflowCreditsReservationKey(params.runId),
      getWorkflowCreditsAccountKey(params.userId),
    ],
  })) as string;

  return JSON.parse(result) as WorkflowCreditsMutationResult;
}

export class WorkflowCreditsService extends Context.Tag(
  "WorkflowCreditsService",
)<
  WorkflowCreditsService,
  {
    readonly getBalanceSummary: (
      userId: string,
    ) => Effect.Effect<WorkflowCreditsSummary, WorkflowInfrastructureError>;
    readonly getRunSummary: (params: {
      runId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowCreditsSummary,
      WorkflowCreditsError | WorkflowInfrastructureError
    >;
    readonly reserveCredits: (params: {
      runId: string;
      userId: string;
      totalCost: number;
    }) => Effect.Effect<
      WorkflowCreditsSummary,
      WorkflowCreditsError | WorkflowInfrastructureError
    >;
    readonly consumeReservedCredits: (params: {
      runId: string;
      userId: string;
      cost: number;
    }) => Effect.Effect<
      WorkflowCreditsSummary,
      WorkflowCreditsError | WorkflowInfrastructureError
    >;
    readonly finalizeReservation: (params: {
      runId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowCreditsSummary,
      WorkflowCreditsError | WorkflowInfrastructureError
    >;
    readonly refundRemainingCredits: (params: {
      runId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowCreditsSummary,
      WorkflowCreditsError | WorkflowInfrastructureError
    >;
  }
>() {
  static readonly functions = Effect.serviceFunctions(this);

  static readonly toCreditsInfraError = (cause: unknown) => {
    if (cause instanceof WorkflowInfrastructureError) {
      return cause;
    }

    return new WorkflowInfrastructureError({
      message: getErrorMessage(cause),
      cause,
    });
  };

  static readonly toCreditsError = (cause: unknown) => {
    if (
      cause instanceof WorkflowCreditsError ||
      cause instanceof WorkflowInfrastructureError
    ) {
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
        try: async () => buildBalanceSummary(await getOrCreateAccount(userId)),
        catch: WorkflowCreditsService.toCreditsInfraError,
      }),
    getRunSummary: ({ runId, userId }) =>
      Effect.tryPromise({
        try: async () => {
          const reservation = await getReservation(runId, userId);
          const account = await getOrCreateAccount(userId);

          return buildRunSummary({
            available: Math.max(
              0,
              account.granted - account.spent - account.reserved,
            ),
            reserved: reservation.reserved,
            totalCost: reservation.totalCost,
            used: reservation.used,
          });
        },
        catch: WorkflowCreditsService.toCreditsError,
      }),
    reserveCredits: ({ runId, userId, totalCost }) =>
      Effect.tryPromise({
        try: async () => {
          const result = await mutateReservation({
            action: "reserve",
            amount: totalCost,
            runId,
            userId,
          });

          if (result.status === "run-conflict") {
            throw new WorkflowCreditsError({
              message: `Run ${runId} is already reserved for another user.`,
            });
          }

          if (result.status === "insufficient") {
            throw new WorkflowCreditsError({
              message: "You do not have enough credits to run this workflow.",
            });
          }

          return buildRunSummary(result);
        },
        catch: WorkflowCreditsService.toCreditsError,
      }),
    consumeReservedCredits: ({ runId, userId, cost }) =>
      Effect.tryPromise({
        try: async () => {
          const result = await mutateReservation({
            action: "consume",
            amount: cost,
            runId,
            userId,
          });

          if (result.status === "not-found") {
            throw new WorkflowCreditsError({
              message: `Credits reservation for run ${runId} was not found.`,
            });
          }

          if (result.status === "insufficient") {
            throw new WorkflowCreditsError({
              message: "Run exceeded its reserved credits.",
            });
          }

          return buildRunSummary(result);
        },
        catch: WorkflowCreditsService.toCreditsError,
      }),
    finalizeReservation: ({ runId, userId }) =>
      Effect.tryPromise({
        try: async () => {
          const result = await mutateReservation({
            action: "finalize",
            amount: 0,
            runId,
            userId,
          });

          if (result.status === "not-found") {
            throw new WorkflowCreditsError({
              message: `Credits reservation for run ${runId} was not found.`,
            });
          }

          return buildRunSummary(result);
        },
        catch: WorkflowCreditsService.toCreditsError,
      }),
    refundRemainingCredits: ({ runId, userId }) =>
      Effect.tryPromise({
        try: async () => {
          const result = await mutateReservation({
            action: "refund",
            amount: 0,
            runId,
            userId,
          });

          if (result.status === "not-found") {
            throw new WorkflowCreditsError({
              message: `Credits reservation for run ${runId} was not found.`,
            });
          }

          return buildRunSummary(result);
        },
        catch: WorkflowCreditsService.toCreditsError,
      }),
  });
}
