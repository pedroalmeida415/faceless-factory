import { Layer, ManagedRuntime } from "effect";
import { WorkflowStorage } from "~/server/workflow/storage";
import { VertexAi } from "~/server/workflow/vertex";

const ServerBaseLayer = Layer.mergeAll(WorkflowStorage.Live);

const VertexAiLayer = VertexAi.Live.pipe(Layer.provide(WorkflowStorage.Live));

const ServerLayer = Layer.mergeAll(ServerBaseLayer, VertexAiLayer);

export const ServerRuntime = ManagedRuntime.make(ServerLayer);
