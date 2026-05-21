"use client";

import { EditorContent } from "@tiptap/react";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { NodeCard, NodeCardHeader, NodeCardPanel, NodeCardTitle } from "~/components/node-card";
import { ScrollArea } from "~/components/ui/scroll-area";
import type { WorkflowPromptNode } from "~/features/workflow/domain/graph";
import {
  PROMPT_VARIABLE_INPUT_CAPACITY,
  PROMPT_VARIABLES_TARGET_HANDLE,
} from "~/features/workflow/domain/nodes/prompt";
import { usePromptEditor } from "../../_hooks/use-prompt-editor";
import { usePromptVariables } from "../../_hooks/use-prompt-variables";
import { SocketRow } from "../socket-row";

type PromptFlowNode = Node<WorkflowPromptNode["data"], WorkflowPromptNode["type"]>;

export function PromptNode(props: NodeProps<PromptFlowNode>) {
  const variables = usePromptVariables(props.id);

  const editor = usePromptEditor({
    nodeId: props.id,
    data: props.data,
    variables,
  });

  return (
    <NodeCard className="group">
      <SocketRow
        handleTop={64}
        id={PROMPT_VARIABLES_TARGET_HANDLE}
        label={`Variables (${variables.length}/${PROMPT_VARIABLE_INPUT_CAPACITY})`}
        muted={variables.length === 0}
      />
      <Handle id="output" position={Position.Right} type="source" />

      <NodeCardHeader>
        <NodeCardTitle>Prompt</NodeCardTitle>
      </NodeCardHeader>
      <NodeCardPanel>
        <ScrollArea
          className="nodrag nopan nowheel max-h-96 cursor-text rounded-lg border bg-muted"
          fitContent
          scrollFade
        >
          <div className="px-3 py-2">
            <EditorContent editor={editor} />
          </div>
        </ScrollArea>
      </NodeCardPanel>
    </NodeCard>
  );
}
