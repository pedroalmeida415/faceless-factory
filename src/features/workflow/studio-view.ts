import type { TaskRunStudioProjectionSlot } from "~/features/runtime/task-run-studio-projection";
import type { WorkflowProject } from "~/features/workflow/project";

export type WorkflowStudioView = {
  readonly project: WorkflowProject;
  readonly runtimeTaskProjection: readonly TaskRunStudioProjectionSlot[];
};
