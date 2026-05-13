import { Layer, ManagedRuntime } from "effect";
import { DatabaseServiceTest } from "~/core/infra/__tests__/database-pglite";
import { PubSubTest } from "~/core/infra/__tests__/pubsub-memory";
import { Features } from "~/features";

const CoreServicesTest = Layer.mergeAll(DatabaseServiceTest, PubSubTest);

const ServerLayerTest = Features.pipe(Layer.provide(CoreServicesTest));

export const ServerRuntimeTest = ManagedRuntime.make(ServerLayerTest);
