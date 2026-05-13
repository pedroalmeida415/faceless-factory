import { Deferred, Effect, Layer } from "effect";
import { createClient } from "redis";
import { PubSubPublishError, PubSubService, PubSubSubscribeError } from "~/core/application/pubsub-service";
import { env } from "~/env";

type AppRedisClient = ReturnType<typeof createClient>;
type RedisMessageHandler = (payload: string) => void;
type RedisChannelSubscription = {
  readonly dispatch: RedisMessageHandler;
  readonly handlers: Set<RedisMessageHandler>;
  readonly ready: Deferred.Deferred<void, PubSubSubscribeError>;
};
type RedisChannelSubscriptionRegistration = {
  readonly shouldSubscribe: boolean;
  readonly subscription: RedisChannelSubscription;
};

export const RedisPubSubLive = Layer.scoped(
  PubSubService,
  Effect.gen(function* () {
    const publisher = yield* acquirePublisher;
    const subscriber = yield* acquireSubscriber(publisher);
    const channelSubscriptions = new Map<string, RedisChannelSubscription>();

    return PubSubService.of({
      publish: (command) =>
        Effect.tryPromise({
          try: () => publisher.publish(command.channel, command.payload),
          catch: (cause) =>
            new PubSubPublishError({
              cause,
              channel: command.channel,
            }),
        }).pipe(Effect.asVoid),
      subscribe: (command) =>
        Effect.acquireRelease(
          addChannelHandler({
            channel: command.channel,
            channelSubscriptions,
            handler: command.onMessage,
            subscriber,
          }),
          (subscription) =>
            removeChannelHandler({
              channel: command.channel,
              channelSubscriptions,
              handler: command.onMessage,
              subscriber,
              subscription,
            }).pipe(
              Effect.catchAll((cause) =>
                Effect.logWarning("Redis Pub/Sub unsubscribe failed", {
                  cause: errorMessage(cause.cause),
                  channel: command.channel,
                }),
              ),
            ),
        ).pipe(Effect.asVoid),
    });
  }),
);

function addChannelHandler(input: {
  readonly channel: string;
  readonly channelSubscriptions: Map<string, RedisChannelSubscription>;
  readonly handler: RedisMessageHandler;
  readonly subscriber: AppRedisClient;
}) {
  return Effect.gen(function* () {
    const { shouldSubscribe, subscription } = yield* getOrCreateChannelSubscription(input);
    yield* Effect.sync(() => {
      subscription.handlers.add(input.handler);
    });

    if (shouldSubscribe) {
      yield* Deferred.complete(
        subscription.ready,
        subscribeRedisChannel(input, subscription.dispatch).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              input.channelSubscriptions.delete(input.channel);
            }),
          ),
        ),
      ).pipe(Effect.fork, Effect.asVoid);
    }

    yield* Deferred.await(subscription.ready).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          subscription.handlers.delete(input.handler);
        }),
      ),
    );

    return subscription;
  });
}

function removeChannelHandler(input: {
  readonly channel: string;
  readonly channelSubscriptions: Map<string, RedisChannelSubscription>;
  readonly handler: RedisMessageHandler;
  readonly subscriber: AppRedisClient;
  readonly subscription: RedisChannelSubscription;
}) {
  return Effect.gen(function* () {
    const shouldUnsubscribe = yield* Effect.sync(() => {
      const activeSubscription = input.channelSubscriptions.get(input.channel);
      if (activeSubscription !== input.subscription) {
        return false;
      }

      input.subscription.handlers.delete(input.handler);
      if (input.subscription.handlers.size > 0) {
        return false;
      }

      input.channelSubscriptions.delete(input.channel);
      return true;
    });

    if (!shouldUnsubscribe) {
      return;
    }

    yield* Deferred.await(input.subscription.ready).pipe(Effect.catchAll(() => Effect.void));
    yield* Effect.tryPromise({
      try: () => input.subscriber.unsubscribe(input.channel, input.subscription.dispatch),
      catch: (cause) =>
        new PubSubSubscribeError({
          cause,
          channel: input.channel,
        }),
    });
  });
}

function getOrCreateChannelSubscription(input: {
  readonly channel: string;
  readonly channelSubscriptions: Map<string, RedisChannelSubscription>;
  readonly subscriber: AppRedisClient;
}): Effect.Effect<RedisChannelSubscriptionRegistration> {
  return Effect.gen(function* () {
    const existingSubscription = input.channelSubscriptions.get(input.channel);
    if (existingSubscription) {
      return {
        shouldSubscribe: false,
        subscription: existingSubscription,
      };
    }

    const ready = yield* Deferred.make<void, PubSubSubscribeError>();
    const handlers = new Set<RedisMessageHandler>();
    const dispatch = (payload: string) => {
      for (const subscribedHandler of handlers) {
        subscribedHandler(payload);
      }
    };
    const subscription = { dispatch, handlers, ready };
    input.channelSubscriptions.set(input.channel, subscription);

    return {
      shouldSubscribe: true,
      subscription,
    };
  });
}

function subscribeRedisChannel(
  input: {
    readonly channel: string;
    readonly subscriber: AppRedisClient;
  },
  dispatch: RedisMessageHandler,
) {
  return Effect.tryPromise({
    try: () => input.subscriber.subscribe(input.channel, dispatch),
    catch: (cause) =>
      new PubSubSubscribeError({
        cause,
        channel: input.channel,
      }),
  }).pipe(Effect.asVoid);
}

const acquirePublisher = Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => {
      const client = createClient({
        pingInterval: 10_000,
        url: env.REDIS_URL,
      });
      attachRedisErrorLogging(client);
      await client.connect();
      return client;
    },
    catch: (cause) =>
      new PubSubSubscribeError({
        cause,
        channel: "*",
      }),
  }),
  (client) =>
    Effect.promise(() => client.quit()).pipe(
      Effect.catchAll((cause) =>
        Effect.logWarning("Redis Pub/Sub publisher shutdown failed", {
          cause: errorMessage(cause),
        }),
      ),
    ),
);

function acquireSubscriber(publisher: AppRedisClient) {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const subscriber = publisher.duplicate();
        attachRedisErrorLogging(subscriber);
        await subscriber.connect();
        return subscriber;
      },
      catch: (cause) =>
        new PubSubSubscribeError({
          cause,
          channel: "*",
        }),
    }),
    (subscriber) =>
      Effect.promise(() => subscriber.quit()).pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning("Redis Pub/Sub subscriber shutdown failed", {
            cause: errorMessage(cause),
          }),
        ),
      ),
  );
}

function attachRedisErrorLogging(client: {
  readonly on: (event: "error", handler: (error: unknown) => void) => unknown;
}) {
  client.on("error", (error) => {
    console.error("Redis client error", error);
  });
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
