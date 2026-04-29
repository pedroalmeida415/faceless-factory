import { Layer, ManagedRuntime } from "effect";
import { WorkflowArtifactStore } from "~/server/workflow/artifact-store";
import { WorkflowCreditsService } from "~/server/workflow/credits";
import { WorkflowExecutionService } from "~/server/workflow/execution-service";
import { WorkflowExecutionStore } from "~/server/workflow/execution-store";
import { WorkflowProjectStore } from "~/server/workflow/project-store";
import { WorkflowStorage } from "~/server/workflow/storage";
import { VertexAi } from "~/server/workflow/vertex";

const ServerBaseLayer = Layer.mergeAll(
  WorkflowCreditsService.Live,
  WorkflowArtifactStore.Live,
  WorkflowProjectStore.Live,
  WorkflowStorage.Live,
  WorkflowExecutionStore.Live,
);

const VertexAiLayer = VertexAi.Live.pipe(Layer.provide(WorkflowStorage.Live));

const WorkflowExecutionLayer = WorkflowExecutionService.Live.pipe(
  Layer.provide(
    Layer.mergeAll(
      WorkflowCreditsService.Live,
      WorkflowArtifactStore.Live,
      WorkflowProjectStore.Live,
      WorkflowExecutionStore.Live,
      VertexAiLayer,
    ),
  ),
);

const ServerLayer = Layer.mergeAll(
  ServerBaseLayer,
  VertexAiLayer,
  WorkflowExecutionLayer,
);

export const ServerRuntime = ManagedRuntime.make(ServerLayer);
