import { WorkflowStudio } from "~/components/workflow/WorkflowStudio";
import { getSession } from "~/server/better-auth/server";
import { getOrCreateWorkflowProject } from "~/server/workflow/projects";

export default async function HomePage() {
  const session = await getSession();

  if (!session?.user) {
    return null;
  }

  const project = await getOrCreateWorkflowProject(session.user.id);

  return <WorkflowStudio project={project} />;
}
