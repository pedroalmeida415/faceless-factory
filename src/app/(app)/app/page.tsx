import { WorkflowStudio } from "~/components/workflow/WorkflowStudio";
import { getSession } from "~/features/auth/server/session";
import { getOrCreateWorkflowStudioView } from "~/features/workflow/server/workflow-studio-view";

export default async function HomePage() {
  const session = await getSession();

  if (!session?.user) {
    return null;
  }

  const view = await getOrCreateWorkflowStudioView(session.user.id);

  return <WorkflowStudio view={view} />;
}
