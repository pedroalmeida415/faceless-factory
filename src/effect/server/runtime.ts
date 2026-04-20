import { Layer, ManagedRuntime } from "effect";
import { WorkflowExecutionService } from "~/server/workflow/execution-service";
import { WorkflowRunStore } from "~/server/workflow/run-store";
import { WorkflowStorage } from "~/server/workflow/storage";
import { VertexAi } from "~/server/workflow/vertex";

const ServerBaseLayer = Layer.mergeAll(
  WorkflowStorage.Live,
  WorkflowRunStore.Live,
);

const VertexAiLayer = VertexAi.Live.pipe(Layer.provide(WorkflowStorage.Live));

const WorkflowExecutionLayer = WorkflowExecutionService.Live.pipe(
  Layer.provide(Layer.mergeAll(WorkflowRunStore.Live, VertexAiLayer)),
);

const ServerLayer = Layer.mergeAll(
  ServerBaseLayer,
  VertexAiLayer,
  WorkflowExecutionLayer,
);

export const ServerRuntime = ManagedRuntime.make(ServerLayer);
