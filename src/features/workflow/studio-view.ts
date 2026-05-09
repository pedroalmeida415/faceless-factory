import type { TaskStudioProjectionSlot } from "~/features/runtime/task-studio-projection";
import type { WorkflowProject } from "~/features/workflow/project";

export type WorkflowStudioView = {
  readonly project: WorkflowProject;
  readonly runtimeTaskProjection: readonly TaskStudioProjectionSlot[];
};
