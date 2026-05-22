"use client";

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { CircleAlertIcon, GripVerticalIcon, Trash2Icon } from "lucide-react";
import { type KeyboardEvent, type RefCallback, useCallback, useEffect, useRef, useState } from "react";
import { NodeCard, NodeCardHeader, NodeCardPanel, NodeCardTitle } from "~/components/node-card";
import { Button } from "~/components/ui/button";
import { CardFrame, CardFrameFooter } from "~/components/ui/card";
import { Field } from "~/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Kbd } from "~/components/ui/kbd";
import { ScrollArea } from "~/components/ui/scroll-area";
import type { WorkflowListNode } from "~/features/workflow/domain/graph";
import { cn } from "~/lib/utils";
import { type OnListItemReorder, reorderListItems, useDraggableListItem } from "../../_hooks/use-draggable-list-item";
import { useWorkflowStore } from "../../_hooks/use-workflow-store";

type ListFlowNode = Node<WorkflowListNode["data"], WorkflowListNode["type"]>;
type ListItemData = WorkflowListNode["data"]["items"][number];

export function ListNode(props: NodeProps<ListFlowNode>) {
  const updateNodeData = useWorkflowStore((store) => store.updateNodeData);

  const inputRefs = useRef<Record<string, HTMLInputElement>>({});
  const [instanceId] = useState(() => Symbol("list-node"));

  const createItem = () => {
    const nextData = structuredClone(props.data);

    const newItemId = `item-${crypto.randomUUID()}`;
    nextData.items.push({ id: newItemId, text: "" });

    updateNodeData<WorkflowListNode>(props.id, nextData);

    queueMicrotask(() => {
      inputRefs.current[newItemId]?.focus();
    });
  };

  const handleItemBlur = (itemId: string, text: string) => {
    const nextData = structuredClone(props.data);
    const itemToUpdate = nextData.items.find((item) => item.id === itemId);

    if (!itemToUpdate) {
      return;
    }

    itemToUpdate.text = text;
    updateNodeData<WorkflowListNode>(props.id, nextData);
  };

  const handleItemKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || !event.currentTarget.value || !inputRefs.current) {
      return;
    }
    event.preventDefault();

    const blankItem = Object.values(inputRefs.current).find((item) => item.value.trim() === "");

    if (blankItem) {
      inputRefs.current[blankItem.id]?.focus();
      return;
    }

    createItem();
  };

  const removeItem = (itemId: string) => {
    const nextData = structuredClone(props.data);
    const itemIndex = nextData.items.findIndex((item) => item.id === itemId);

    if (itemIndex === -1) {
      return;
    }

    nextData.items.splice(itemIndex, 1);

    let nextFocusItemId = nextData.items[Math.min(itemIndex, nextData.items.length - 1)]?.id;

    if (!nextFocusItemId) {
      nextFocusItemId = `item-${crypto.randomUUID()}`;
      nextData.items.push({ id: nextFocusItemId, text: "" });
    }

    updateNodeData<WorkflowListNode>(props.id, nextData);

    queueMicrotask(() => {
      inputRefs.current[nextFocusItemId]?.focus();
    });
  };

  const reorderItem = useCallback(
    ({ sourceId, targetId, closestEdge }: Parameters<OnListItemReorder>[0]) => {
      const nextData = structuredClone(props.data);
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
      updateNodeData<WorkflowListNode>(props.id, nextData);
    },
    [props.data, props.id, updateNodeData],
  );

  const registerInput = (itemId: string): RefCallback<HTMLInputElement> => {
    return (el) => {
      if (el) {
        inputRefs.current[itemId] = el;
        return;
      }

      delete inputRefs.current[itemId];
    };
  };

  return (
    <CardFrame>
      <NodeCard>
        <NodeCardHeader>
          <NodeCardTitle>List</NodeCardTitle>
        </NodeCardHeader>
        <NodeCardPanel className="p-0">
          <ScrollArea className="nodrag nopan nowheel max-h-110" scrollFade>
            <div className="p-6">
              {props.data.items.map((item, index) => (
                <ListItem
                  key={item.id}
                  ref={registerInput(item.id)}
                  index={index}
                  item={item}
                  instanceId={instanceId}
                  onBlur={handleItemBlur}
                  onKeyDown={handleItemKeyDown}
                  onRemove={removeItem}
                  onReorder={reorderItem}
                />
              ))}
            </div>
          </ScrollArea>
        </NodeCardPanel>
      </NodeCard>
      <CardFrameFooter>
        <div className="flex items-center gap-1 text-muted-foreground text-xs">
          <CircleAlertIcon className="size-3 h-lh shrink-0" />
          Type and press <Kbd>Enter</Kbd> to add a new item.
        </div>
      </CardFrameFooter>
      <Handle position={Position.Right} type="source" />
    </CardFrame>
  );
}

function ListItem({
  index,
  item,
  instanceId,
  onBlur,
  onKeyDown,
  onRemove,
  onReorder,
  ref,
}: {
  readonly index: number;
  readonly item: ListItemData;
  readonly instanceId: symbol;
  readonly onBlur: (itemId: string, text: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onRemove: (itemId: string) => void;
  readonly onReorder: OnListItemReorder;
  readonly ref: RefCallback<HTMLInputElement>;
}) {
  const [draft, setDraft] = useState(item.text);
  const { closestEdge, dragHandleRef, isDragging, itemRef } = useDraggableListItem({
    index,
    instanceId,
    itemId: item.id,
    onReorder,
    previewText: draft,
  });

  useEffect(() => setDraft(item.text), [item.text]);

  return (
    <div ref={itemRef} className="relative py-1 first:pt-0 last:pb-0">
      <div className={cn("group/list-item flex items-center gap-4 transition-opacity", isDragging && "opacity-40")}>
        <div aria-hidden="true" className="w-4.5 shrink-0 select-none text-muted-foreground text-xs/0 tabular-nums">
          {index + 1}
        </div>
        <Field className="flex-1" name={item.id}>
          <InputGroup>
            <InputGroupInput
              aria-label={`List item ${index + 1}`}
              id={item.id}
              type="text"
              onBlur={() => onBlur(item.id, draft)}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={onKeyDown}
              value={draft}
              ref={ref}
            />
            <InputGroupAddon
              align="inline-end"
              className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/list-item:opacity-100"
            >
              <Button
                aria-label={`Remove list item ${index + 1}`}
                className="border-none text-muted-foreground transition-colors hover:text-destructive"
                onClick={() => onRemove(item.id)}
                size="icon-xs"
                variant="ghost"
              >
                <Trash2Icon />
              </Button>
            </InputGroupAddon>
          </InputGroup>
        </Field>
        <Button
          aria-label={`Drag list item ${index + 1}`}
          className="shrink-0 cursor-grab touch-none border-none text-muted-foreground active:cursor-grabbing"
          ref={dragHandleRef}
          type="button"
          size="icon-xs"
          variant="ghost"
        >
          <GripVerticalIcon />
        </Button>
      </div>
      {closestEdge && <DropIndicator closestEdge={closestEdge} />}
    </div>
  );
}

const DropIndicator = ({ closestEdge }: { closestEdge: "top" | "bottom" }) => {
  return (
    <div
      className={cn(
        "pointer-events-none absolute left-1/2 z-10 h-0.5 w-1/2 -translate-x-1/2 rounded-full bg-ring",
        closestEdge === "top" ? "top-0 -translate-y-1/2" : "bottom-0 translate-y-1/2",
      )}
    />
  );
};
