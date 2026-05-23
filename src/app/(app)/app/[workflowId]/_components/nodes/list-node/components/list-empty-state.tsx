import { ImageIcon, ListIcon, TextIcon } from "lucide-react";
import { NodeCardPanel } from "~/components/node-card";
import { Button } from "~/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import type { WorkflowListNode } from "~/features/workflow/domain/graph";
import { useWorkflowStore } from "../../../../_hooks/use-workflow-store";
import { createTextListDataWithEditableBlank } from "../list-node-data";

export function ListEmptyState({ data, nodeId }: { readonly data: WorkflowListNode["data"]; readonly nodeId: string }) {
  const updateNodeData = useWorkflowStore((store) => store.updateNodeData);

  function addText() {
    const next = createTextListDataWithEditableBlank(data);
    updateNodeData<WorkflowListNode>(nodeId, next.data);
  }

  return (
    <NodeCardPanel className="p-0">
      <Empty>
        <EmptyHeader>
          <EmptyMedia className="size-16" variant="icon">
            <ListIcon className="size-8.5" />
          </EmptyMedia>
          <EmptyTitle>No items in this list yet</EmptyTitle>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button size="xl" onClick={addText} variant="secondary">
            <TextIcon aria-hidden="true" />
            Add text
          </Button>
          <Button size="xl" variant="secondary">
            <ImageIcon aria-hidden="true" />
            Add media
          </Button>
        </EmptyContent>
      </Empty>
    </NodeCardPanel>
  );
}
