import { WorkflowStudio } from "~/components/workflow/WorkflowStudio";
import { getSession } from "~/server/better-auth/server";
import { getOrCreateWorkflowStudioView } from "~/server/workflow/workflow-studio-view";

export default async function HomePage() {
  const session = await getSession();

  if (!session?.user) {
    return null;
  }

  const view = await getOrCreateWorkflowStudioView(session.user.id);

  return <WorkflowStudio view={view} />;
}
