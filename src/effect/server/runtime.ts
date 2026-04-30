import { Layer, ManagedRuntime } from "effect";
import { WorkflowCreditsService } from "~/server/workflow/credits";
import { WorkflowProjectStore } from "~/server/workflow/project-store";
import { WorkflowStorage } from "~/server/workflow/storage";
import { VertexAi } from "~/server/workflow/vertex";

const ServerBaseLayer = Layer.mergeAll(
  WorkflowCreditsService.Live,
  WorkflowProjectStore.Live,
  WorkflowStorage.Live,
);

const VertexAiLayer = VertexAi.Live.pipe(Layer.provide(WorkflowStorage.Live));

const ServerLayer = Layer.mergeAll(ServerBaseLayer, VertexAiLayer);

export const ServerRuntime = ManagedRuntime.make(ServerLayer);
