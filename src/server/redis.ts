import { createClient } from "redis";

import { env } from "~/env";

type AppRedisClient = ReturnType<typeof createClient>;

type GlobalRedisState = {
  client: AppRedisClient | undefined;
  connectPromise: Promise<AppRedisClient> | undefined;
};

const globalForRedis = globalThis as typeof globalThis & {
  __workflowRedis?: GlobalRedisState;
};

function attachErrorLogging(client: AppRedisClient) {
  client.on("error", (error) => {
    console.error("Redis client error", error);
  });
}

function createRedisClient() {
  const client = createClient({
    pingInterval: 10_000,
    url: env.REDIS_URL,
  });

  attachErrorLogging(client);

  return client;
}

const redisState = globalForRedis.__workflowRedis ?? {
  client: undefined,
  connectPromise: undefined,
};

if (!globalForRedis.__workflowRedis) {
  globalForRedis.__workflowRedis = redisState;
}

export async function getRedisClient() {
  if (!redisState.client) {
    redisState.client = createRedisClient();
  }

  const client = redisState.client;

  if (client.isReady) {
    return client;
  }

  redisState.connectPromise ??= client.connect().then(
    (connectedClient) => {
      redisState.connectPromise = undefined;
      return connectedClient;
    },
    (error) => {
      redisState.connectPromise = undefined;
      throw error;
    },
  );

  return redisState.connectPromise;
}

export async function createRedisSubscriber() {
  const client = (await getRedisClient()).duplicate();
  attachErrorLogging(client);
  await client.connect();
  return client;
}
