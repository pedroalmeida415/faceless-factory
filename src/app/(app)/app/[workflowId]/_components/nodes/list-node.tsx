"use client";

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardHeader, CardPanel, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import type { WorkflowListNode, WorkflowNode } from "~/features/workflow/domain/graph";
import { useWorkflowStore } from "../../_hooks/use-workflow-store";

type ListFlowNode = Node<WorkflowListNode["data"], "list">;

export function ListNode(props: NodeProps<ListFlowNode>) {
  const updateNode = useWorkflowStore((store) => store.updateNode);

  return (
    <Card>
      <Handle position={Position.Right} type="source" />
      <CardHeader>
        <CardTitle>List</CardTitle>
      </CardHeader>
      <CardPanel className="nodrag">
        {props.data.items.map((item, index) => (
          <ListItemRow key={item.id} index={index} item={item} nodeId={props.id} updateNode={updateNode} />
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const blankItem = props.data.items.find((item) => item.text.trim() === "");
            if (blankItem) {
              document.getElementById(`list-item-${blankItem.id}`)?.focus();
              return;
            }

            updateNode(props.id, (candidate: WorkflowNode) =>
              candidate.type === "list"
                ? {
                    ...candidate,
                    data: {
                      items: [...candidate.data.items, { id: `item-${crypto.randomUUID()}`, text: "" }],
                    },
                  }
                : candidate,
            );
          }}
        >
          <PlusIcon /> Add row
        </Button>
      </CardPanel>
    </Card>
  );
}

function ListItemRow({
  index,
  item,
  nodeId,
  updateNode,
}: {
  readonly index: number;
  readonly item: WorkflowListNode["data"]["items"][number];
  readonly nodeId: string;
  readonly updateNode: (nodeId: string, updater: (node: WorkflowNode) => WorkflowNode) => void;
}) {
  const [draft, setDraft] = useState(item.text);

  useEffect(() => setDraft(item.text), [item.text]);

  return (
    <div className="flex items-center gap-2">
      <span className="w-5 text-center text-white/45 text-xs">{index + 1}</span>
      <Input
        id={`list-item-${item.id}`}
        aria-label={`List item ${index + 1}`}
        onBlur={() =>
          updateNode(nodeId, (node: WorkflowNode) =>
            node.type === "list"
              ? {
                  ...node,
                  data: {
                    items: node.data.items.map((candidate) =>
                      candidate.id === item.id ? { ...candidate, text: draft } : candidate,
                    ),
                  },
                }
              : node,
          )
        }
        onChange={(event) => setDraft(event.currentTarget.value)}
        value={draft}
      />
    </div>
  );
}
