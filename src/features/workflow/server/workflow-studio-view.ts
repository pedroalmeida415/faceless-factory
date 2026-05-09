import { Effect } from "effect";
import { getTaskProjectionForWorkflow } from "~/features/runtime/server/task-projection-repository";
import { getOrCreateWorkflowProject } from "~/features/workflow/server/projects";
import type { WorkflowStudioView } from "~/features/workflow/studio-view";
import { ServerRuntime } from "~/server/effect";

export async function getOrCreateWorkflowStudioView(
  ownerUserId: string,
): Promise<WorkflowStudioView> {
  return ServerRuntime.runPromise(
    Effect.gen(function* () {
      const project = yield* getOrCreateWorkflowProject(ownerUserId);
      const runtimeTaskProjection = yield* getTaskProjectionForWorkflow({
        ownerUserId,
        workflowId: project.id,
      });

      return { project, runtimeTaskProjection };
    }),
  );
}
