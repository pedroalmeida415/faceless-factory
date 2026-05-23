"use client";

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { NodeCard, NodeCardHeader, NodeCardPanel, NodeCardTitle } from "~/components/node-card";
import type { WorkflowListNode } from "~/features/workflow/domain/graph";
import { getWorkflowListDataMode } from "~/features/workflow/domain/nodes/list";
import { ListEmptyState } from "./components/list-empty-state";
import { MediaListMode } from "./components/media-list-mode";
import { TextListMode } from "./components/text-list-mode";

type ListFlowNode = Node<WorkflowListNode["data"], WorkflowListNode["type"]>;

export function ListNode(props: NodeProps<ListFlowNode>) {
  const mode = getWorkflowListDataMode(props.data);

  return (
    <NodeCard>
      <NodeCardHeader className="border-b">
        <NodeCardTitle>List</NodeCardTitle>
      </NodeCardHeader>
      {mode === "text" && <TextListMode data={props.data} nodeId={props.id} />}
      {mode === "media" && <MediaListMode />}
      {!mode && <ListEmptyState data={props.data} nodeId={props.id} />}
      {mode && <Handle position={Position.Right} type="source" />}
    </NodeCard>
  );
}
