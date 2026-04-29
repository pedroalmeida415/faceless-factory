import { Effect } from "effect";

import { WorkflowStudio } from "~/components/workflow/WorkflowStudio";
import { ServerRuntime } from "~/effect/server/runtime";
import { buildWorkflowOutputProjection } from "~/lib/workflow/execution/artifact-projection";
import type { WorkflowOutputArtifacts } from "~/lib/workflow/execution/types";
import { getSession } from "~/server/better-auth/server";
import { WorkflowArtifactStore } from "~/server/workflow/artifact-store";
import { getOrCreateWorkflowProject } from "~/server/workflow/projects";

export default async function HomePage() {
  const session = await getSession();

  if (!session?.user) {
    return null;
  }

  const project = await getOrCreateWorkflowProject(session.user.id);
  const artifacts = await ServerRuntime.runPromise(
    Effect.gen(function* () {
      const workflowArtifactStore = yield* WorkflowArtifactStore;
      return yield* workflowArtifactStore.getProjectArtifacts({
        ownerUserId: session.user.id,
        projectId: project.id,
      });
    }),
  ).catch(() => ({ outputResults: [] }) satisfies WorkflowOutputArtifacts);

  return (
    <WorkflowStudio
      project={{
        ...project,
        document: buildWorkflowOutputProjection({
          artifacts,
          document: project.document,
        }),
      }}
    />
  );
}
