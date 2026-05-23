import { PlusIcon } from "lucide-react";
import { Fragment, type KeyboardEvent, useCallback, useEffect, useState } from "react";
import { NodeCardPanel } from "~/components/node-card";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Separator } from "~/components/ui/separator";
import type { WorkflowListNode } from "~/features/workflow/domain/graph";
import { useWorkflowStore } from "../../../../_hooks/use-workflow-store";
import { type OnListItemReorder, reorderListItems } from "../_hooks/use-draggable-list-item";
import { createTextListDataWithEditableBlank } from "../list-node-data";
import { TextListItem } from "./text-list-item";

export function TextListMode({ data, nodeId }: { readonly data: WorkflowListNode["data"]; readonly nodeId: string }) {
  const updateNodeData = useWorkflowStore((store) => store.updateNodeData);
  const [editingItemId, setEditingItemId] = useState(() => getInitialEditingItemId(data));
  const [instanceId] = useState(() => Symbol("list-node"));

  useEffect(() => {
    if (editingItemId && !data.items.some((item) => item.id === editingItemId)) {
      setEditingItemId(null);
    }
  }, [data.items, editingItemId]);

  function beginEditingItem(itemId: string) {
    setEditingItemId(itemId);
  }

  function createTextItem() {
    const next = createTextListDataWithEditableBlank(data);
    updateNodeData<WorkflowListNode>(nodeId, next.data);
    beginEditingItem(next.itemId);
  }

  function commitItemText(itemId: string, text: string) {
    const nextData = structuredClone(data);
    const itemToUpdate = nextData.items.find((item) => item.id === itemId);

    if (!itemToUpdate) {
      return;
    }

    nextData.mode = "text";
    itemToUpdate.text = text;
    updateNodeData<WorkflowListNode>(nodeId, nextData);
    setEditingItemId(null);
  }

  function removeItem(itemId: string) {
    const nextData = structuredClone(data);
    const itemIndex = nextData.items.findIndex((item) => item.id === itemId);

    if (itemIndex === -1) {
      return;
    }

    nextData.items.splice(itemIndex, 1);

    if (nextData.items.length === 0) {
      nextData.mode = null;
    }

    updateNodeData<WorkflowListNode>(nodeId, nextData);

    if (editingItemId === itemId) {
      setEditingItemId(null);
    }
  }

  function cancelItemEdit(itemId: string) {
    const item = data.items.find((candidate) => candidate.id === itemId);

    if (item?.text.trim() === "") {
      removeItem(itemId);
      return;
    }

    setEditingItemId(null);
  }

  function handleItemKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, itemId: string, draft: string) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelItemEdit(itemId);
      return;
    }

    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commitItemText(itemId, draft);
    }
  }

  const reorderItem = useCallback(
    ({ sourceId, targetId, closestEdge }: Parameters<OnListItemReorder>[0]) => {
      const nextData = structuredClone(data);
      const nextItems = reorderListItems({
        items: nextData.items,
        sourceId,
        targetId,
        closestEdge,
      });

      if (!nextItems) {
        return;
      }

      nextData.items = nextItems;
      updateNodeData<WorkflowListNode>(nodeId, nextData);
    },
    [data, nodeId, updateNodeData],
  );

  return (
    <NodeCardPanel className="min-h-96 p-3">
      <ScrollArea className="nowheel max-h-90 data-has-overflow-y:pe-3.5" scrollFade scrollbarGutter>
        {data.items.map((item, index) => (
          <Fragment key={item.id}>
            <TextListItem
              index={index}
              instanceId={instanceId}
              isEditing={editingItemId === item.id}
              item={item}
              onBeginEdit={beginEditingItem}
              onCancel={cancelItemEdit}
              onCommit={commitItemText}
              onKeyDown={handleItemKeyDown}
              onRemove={removeItem}
              onReorder={reorderItem}
            />
            {index < data.items.length - 1 ? (
              <div className="px-3">
                <Separator />
              </div>
            ) : null}
          </Fragment>
        ))}
      </ScrollArea>
      <Button
        aria-label="Add list item"
        className="nodrag absolute bottom-3 left-3 size-14 rounded-full"
        onClick={createTextItem}
        size="icon-lg"
        type="button"
        variant="ghost"
      >
        <PlusIcon aria-hidden="true" className="size-6" />
      </Button>
    </NodeCardPanel>
  );
}

function getInitialEditingItemId(data: WorkflowListNode["data"]) {
  if (data.items.some((item) => item.text.trim() !== "")) {
    return null;
  }

  return data.items.find((item) => item.text.trim() === "")?.id ?? null;
}
