"use client";

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { useState } from "react";
import { NodeCard, NodeCardHeader, NodeCardPanel, NodeCardTitle } from "~/components/node-card";
import { Textarea } from "~/components/ui/textarea";
import type { WorkflowNode, WorkflowPromptNode } from "~/features/workflow/domain/graph";
import { useWorkflowStore } from "../../_hooks/use-workflow-store";

type PromptFlowNode = Node<WorkflowPromptNode["data"], "prompt">;

export function PromptNode(props: NodeProps<PromptFlowNode>) {
  const promptText = props.data.text;
  const updateNode = useWorkflowStore((store) => store.updateNode);
  const [draft, setDraft] = useState(promptText);

  return (
    <NodeCard>
      <Handle position={Position.Right} type="source" />
      <NodeCardHeader>
        <NodeCardTitle>Prompt</NodeCardTitle>
      </NodeCardHeader>
      <NodeCardPanel>
        <Textarea
          aria-label="Prompt text"
          className="nodrag"
          onBlur={() =>
            updateNode(props.id, (candidate: WorkflowNode) =>
              candidate.type === "prompt" ? { ...candidate, data: { text: draft } } : candidate,
            )
          }
          onChange={(event) => setDraft(event.currentTarget.value)}
          value={draft}
        />
      </NodeCardPanel>
    </NodeCard>
  );
}
