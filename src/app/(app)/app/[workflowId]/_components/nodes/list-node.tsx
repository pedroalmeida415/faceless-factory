"use client";

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { CircleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NodeCard, NodeCardHeader, NodeCardPanel, NodeCardTitle } from "~/components/node-card";
import { CardFrame, CardFrameFooter } from "~/components/ui/card";
import { Field, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Kbd } from "~/components/ui/kbd";
import type { WorkflowListNode } from "~/features/workflow/domain/graph";
import { useWorkflowStore } from "../../_hooks/use-workflow-store";

type ListFlowNode = Node<WorkflowListNode["data"], WorkflowListNode["type"]>;
type ListItemData = WorkflowListNode["data"]["items"][number];

export function ListNode(props: NodeProps<ListFlowNode>) {
  const updateNodeData = useWorkflowStore((store) => store.updateNodeData);

  const inputRefs = useRef<Record<string, HTMLInputElement>>({});

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

  const handleItemKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
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

  return (
    <CardFrame>
      <NodeCard>
        <NodeCardHeader>
          <NodeCardTitle>List</NodeCardTitle>
        </NodeCardHeader>
        <NodeCardPanel>
          <div className="nodrag flex flex-col gap-2">
            {props.data.items.map((item, index) => (
              <ListItem
                key={item.id}
                ref={(el: HTMLInputElement) => (inputRefs.current[item.id] = el as HTMLInputElement)}
                index={index}
                item={item}
                onBlur={handleItemBlur}
                onKeyDown={handleItemKeyDown}
              />
            ))}
          </div>
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
  onBlur,
  onKeyDown,
  ref,
}: {
  readonly index: number;
  readonly item: ListItemData;
  readonly onBlur: (itemId: string, text: string) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  readonly ref: (el: HTMLInputElement) => void;
}) {
  const [draft, setDraft] = useState(item.text);

  useEffect(() => setDraft(item.text), [item.text]);

  return (
    <Field className="flex-row items-center gap-2" name={item.id}>
      <FieldLabel
        aria-label={`List item ${index + 1}`}
        className="w-4.5 shrink-0 justify-start text-white/45 text-xs tabular-nums"
      >
        {index + 1}
      </FieldLabel>
      <Input
        id={item.id}
        type="text"
        onBlur={() => onBlur(item.id, draft)}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        value={draft}
        ref={ref}
      />
    </Field>
  );
}
