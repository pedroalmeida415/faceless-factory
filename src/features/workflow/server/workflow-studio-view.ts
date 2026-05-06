import { Effect } from "effect";
import { getTaskRunProjectionForWorkflow } from "~/features/runtime/server/task-projection-repository";
import { getOrCreateWorkflowProject } from "~/features/workflow/server/projects";
import type { WorkflowStudioView } from "~/features/workflow/studio-view";
import { DatabaseServiceLive } from "~/server/services/database";

export async function getOrCreateWorkflowStudioView(
  ownerUserId: string,
): Promise<WorkflowStudioView> {
  const project = await getOrCreateWorkflowProject(ownerUserId);
  const runtimeTaskProjection = await Effect.runPromise(
    getTaskRunProjectionForWorkflow({
      ownerUserId,
      workflowId: project.id,
    }).pipe(Effect.provide(DatabaseServiceLive)),
  );

  return { project, runtimeTaskProjection };
}
