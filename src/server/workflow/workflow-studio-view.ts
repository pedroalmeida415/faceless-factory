import type { WorkflowStudioView } from "~/lib/workflow/studio-view";
import { db } from "~/server/db";
import { getOrCreateWorkflowProject } from "~/server/workflow/projects";
import { getTaskRunProjectionForWorkflow } from "~/server/workflow-runtime/workflow-runtime-task-projection-repository";

export async function getOrCreateWorkflowStudioView(
  ownerUserId: string,
): Promise<WorkflowStudioView> {
  const project = await getOrCreateWorkflowProject(ownerUserId);
  const runtimeTaskProjection = await getTaskRunProjectionForWorkflow(db, {
    ownerUserId,
    workflowId: project.id,
  });

  return { project, runtimeTaskProjection };
}
