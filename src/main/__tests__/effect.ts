import { Layer, ManagedRuntime } from "effect";
import { DatabaseTest } from "~/core/infra/__tests__/database-pglite";
import { PubSubTest } from "~/core/infra/__tests__/pubsub-memory";
import { Features } from "~/features";

const CoreServicesTest = Layer.mergeAll(DatabaseTest, PubSubTest);

const ServerLayerTest = Features.pipe(Layer.provideMerge(CoreServicesTest));

export const ServerRuntimeTest = ManagedRuntime.make(ServerLayerTest);
