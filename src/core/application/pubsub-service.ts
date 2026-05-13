import { Context, Data, type Effect, type Scope } from "effect";

export type PublishMessageCommand = {
  readonly channel: string;
  readonly payload: string;
};

export type SubscribeMessagesCommand = {
  readonly channel: string;
  readonly onMessage: (payload: string) => void;
};

export class PubSubPublishError extends Data.TaggedError("PubSubPublishError")<{
  readonly cause: unknown;
  readonly channel: string;
}> {}

export class PubSubSubscribeError extends Data.TaggedError("PubSubSubscribeError")<{
  readonly cause: unknown;
  readonly channel: string;
}> {}

export type PubSubError = PubSubPublishError | PubSubSubscribeError;

export type PubSubServiceApi = {
  readonly publish: (command: PublishMessageCommand) => Effect.Effect<void, PubSubPublishError>;
  readonly subscribe: (command: SubscribeMessagesCommand) => Effect.Effect<void, PubSubSubscribeError, Scope.Scope>;
};

export class PubSubService extends Context.Tag("PubSubService")<PubSubService, PubSubServiceApi>() {}
