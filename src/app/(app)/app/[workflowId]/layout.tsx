import { ReactFlowProvider } from "@xyflow/react";
import type { ReactNode } from "react";
import { api } from "~/main/trpc/rsc";
import { WorkflowStoreProvider } from "./_store/workflow-store-provider";

type WorkflowLayoutParams = { readonly workflowId: string };

export default async function WorkflowLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<WorkflowLayoutParams> | WorkflowLayoutParams;
}) {
  const { workflowId } = await params;
  const workflow = await api.workflow.getWorkflow({ workflowId });

  return (
    <WorkflowStoreProvider initialState={workflow}>
      <ReactFlowProvider>{children}</ReactFlowProvider>
    </WorkflowStoreProvider>
  );
}
