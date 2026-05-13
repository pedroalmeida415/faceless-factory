import { Effect, Layer, Ref } from "effect";
import { PubSubService } from "~/core/application/pubsub-service";

type MessageHandler = (payload: string) => void;

export const PubSubTest = Layer.effect(
  PubSubService,
  Effect.gen(function* () {
    const subscriptions = yield* Ref.make(new Map<string, ReadonlySet<MessageHandler>>());

    return PubSubService.of({
      publish: ({ channel, payload }) =>
        Effect.gen(function* () {
          const handlers = yield* Ref.get(subscriptions).pipe(
            Effect.map((channels) => channels.get(channel) ?? new Set<MessageHandler>()),
          );
          yield* Effect.forEach(handlers, (handler) => Effect.sync(() => handler(payload)));
        }),
      subscribe: ({ channel, onMessage }) =>
        Ref.update(subscriptions, (channels) => {
          const next = new Map(channels);
          const handlers = new Set(next.get(channel) ?? []);
          handlers.add(onMessage);
          next.set(channel, handlers);
          return next;
        }).pipe(
          Effect.zipRight(
            Effect.addFinalizer(() =>
              Ref.update(subscriptions, (channels) => {
                const next = new Map(channels);
                const handlers = new Set(next.get(channel) ?? []);
                handlers.delete(onMessage);
                if (handlers.size === 0) {
                  next.delete(channel);
                } else {
                  next.set(channel, handlers);
                }
                return next;
              }),
            ),
          ),
        ),
    });
  }),
);
