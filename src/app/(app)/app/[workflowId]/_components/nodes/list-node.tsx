"use client";

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { NodeCard, NodeCardFooter, NodeCardHeader, NodeCardPanel, NodeCardTitle } from "~/components/node-card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { WorkflowListNode } from "~/features/workflow/domain/graph";
import { useWorkflowStore } from "../../_hooks/use-workflow-store";
import type { WorkflowStore } from "../../_store/workflow-store";

type ListFlowNode = Node<WorkflowListNode["data"], WorkflowListNode["type"]>;

export function ListNode(props: NodeProps<ListFlowNode>) {
  const updateNodeData = useWorkflowStore((store) => store.updateNodeData);

  return (
    <NodeCard>
      <Handle position={Position.Right} type="source" />
      <NodeCardHeader>
        <NodeCardTitle>List</NodeCardTitle>
      </NodeCardHeader>
      <NodeCardPanel className="nodrag">
        {props.data.items.map((item, index) => (
          <ListItemRow
            key={item.id}
            index={index}
            item={item}
            items={props.data.items}
            nodeId={props.id}
            updateNodeData={updateNodeData}
          />
        ))}
      </NodeCardPanel>
      <NodeCardFooter>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const blankItem = props.data.items.find((item) => item.text.trim() === "");
            if (blankItem) {
              document.getElementById(`list-item-${blankItem.id}`)?.focus();
              return;
            }

            const nextData = structuredClone(props.data);
            nextData.items.push({ id: `item-${crypto.randomUUID()}`, text: "" });
            updateNodeData<WorkflowListNode>(props.id, nextData);
          }}
        >
          <PlusIcon /> Add row
        </Button>
      </NodeCardFooter>
    </NodeCard>
  );
}

function ListItemRow({
  index,
  item,
  items,
  nodeId,
  updateNodeData,
}: {
  readonly index: number;
  readonly item: WorkflowListNode["data"]["items"][number];
  readonly items: WorkflowListNode["data"]["items"];
  readonly nodeId: string;
  readonly updateNodeData: WorkflowStore["updateNodeData"];
}) {
  const [draft, setDraft] = useState(item.text);

  useEffect(() => setDraft(item.text), [item.text]);

  return (
    <div className="flex items-center gap-2">
      <span className="w-5 text-center text-white/45 text-xs">{index + 1}</span>
      <Input
        id={`list-item-${item.id}`}
        aria-label={`List item ${index + 1}`}
        onBlur={() => {
          const nextData = structuredClone({ items });
          const itemToUpdate = nextData.items.find((candidate) => candidate.id === item.id);

          if (!itemToUpdate) {
            return;
          }

          itemToUpdate.text = draft;
          updateNodeData<WorkflowListNode>(nodeId, nextData);
        }}
        onChange={(event) => setDraft(event.currentTarget.value)}
        value={draft}
      />
    </div>
  );
}
