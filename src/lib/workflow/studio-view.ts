import type { WorkflowProject } from "~/lib/workflow/project";
import type { TaskRunStudioProjectionSlot } from "~/lib/workflow-runtime/task-run-studio-projection";

export type WorkflowStudioView = {
  readonly project: WorkflowProject;
  readonly runtimeTaskProjection: readonly TaskRunStudioProjectionSlot[];
};
