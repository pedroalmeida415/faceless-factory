"use client";

import { EditorContent } from "@tiptap/react";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { useState } from "react";
import { NodeCard, NodeCardFooter, NodeCardHeader, NodeCardPanel, NodeCardTitle } from "~/components/node-card";
import { Button } from "~/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import type { WorkflowPromptNode } from "~/features/workflow/domain/graph";
import { usePromptEditor } from "../../_hooks/use-prompt-editor";

type PromptFlowNode = Node<WorkflowPromptNode["data"], WorkflowPromptNode["type"]>;

export function PromptNode(props: NodeProps<PromptFlowNode>) {
  const [displayMode, setDisplayMode] = useState<"source-value" | "source" | "value">("source-value");

  const editor = usePromptEditor()

  return (
    <NodeCard className="group">
      <NodeCardHeader>
        <NodeCardTitle>Prompt</NodeCardTitle>
      </NodeCardHeader>
      <NodeCardPanel>
        <div className="nodrag nopan nowheel cursor-text overflow-hidden rounded-lg border bg-muted">
          <div className="max-h-96 overflow-y-auto rounded-lg px-3 py-2">
            <EditorContent editor={editor} />
          </div>
        </div>
      </NodeCardPanel>
      <NodeCardFooter className="flex justify-between gap-2">
        <Button size="sm" type="button" variant="outline" className="nodrag nopan">
          + Add variable
        </Button>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs uppercase tracking-[0.24em]">Display</span>
          <Select
            value={displayMode}
            onValueChange={(value) => setDisplayMode(value as "source-value" | "source" | "value")}
          >
            <SelectTrigger className="nodrag nopan h-8 w-40 text-xs">
              <SelectValue>
                {displayMode === "source-value" ? "Source + Value" : displayMode === "value" ? "Value" : "Source"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="source-value">Source + Value</SelectItem>
              <SelectItem value="value">Value</SelectItem>
              <SelectItem value="source">Source</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </NodeCardFooter>

      <Handle id="output" position={Position.Right} type="source" />
    </NodeCard>
  );
}
