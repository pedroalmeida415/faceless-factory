"use client";

import { Background, Controls, ReactFlow } from "@xyflow/react";
import type { WorkflowEdge, WorkflowNode } from "~/features/workflow/domain/graph";
import { useWorkflowStore } from "../_hooks/use-workflow-store";
import { workflowNodeTypes } from "./nodes";

export function NodeEditor() {
  const edges = useWorkflowStore((store) => store.edges);
  const nodes = useWorkflowStore((store) => store.nodes);
  const onConnect = useWorkflowStore((store) => store.onConnect);
  const onEdgesChange = useWorkflowStore((store) => store.onEdgesChange);
  const onNodesChange = useWorkflowStore((store) => store.onNodesChange);
  const closeNodeInspector = useWorkflowStore((store) => store.closeNodeInspector);
  const selectNode = useWorkflowStore((store) => store.selectNode);

  return (
    <ReactFlow<WorkflowNode, WorkflowEdge>
      data-testid="workflow-surface"
      edges={edges}
      fitView
      nodeTypes={workflowNodeTypes}
      nodes={nodes}
      onConnect={onConnect}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_, node) => selectNode(node.id, node.type)}
      onNodesChange={onNodesChange}
      onPaneClick={closeNodeInspector}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}
