import { Effect } from "effect";
import type { WorkflowStudioView } from "~/lib/workflow/studio-view";
import { getOrCreateWorkflowProject } from "~/server/workflow/projects";
import { createWorkflowRuntimeSqlLayer } from "~/server/workflow-runtime/workflow-runtime-composition";
import { getTaskRunProjectionForWorkflow } from "~/server/workflow-runtime/workflow-runtime-task-projection-repository";

export async function getOrCreateWorkflowStudioView(
  ownerUserId: string,
): Promise<WorkflowStudioView> {
  const project = await getOrCreateWorkflowProject(ownerUserId);
  const runtimeTaskProjection = await Effect.runPromise(
    getTaskRunProjectionForWorkflow({
      ownerUserId,
      workflowId: project.id,
    }).pipe(Effect.provide(createWorkflowRuntimeSqlLayer())),
  );

  return { project, runtimeTaskProjection };
}
