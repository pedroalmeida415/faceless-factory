"use client";

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { PlusIcon } from "lucide-react";
import { NodeCard, NodeCardFooter, NodeCardHeader, NodeCardPanel, NodeCardTitle } from "~/components/node-card";
import { Button } from "~/components/ui/button";
import type { WorkflowAssetNode } from "~/features/workflow/domain/graph";
import { useWorkflowStore } from "../../_hooks/use-workflow-store";

type AssetFlowNode = Node<WorkflowAssetNode["data"], WorkflowAssetNode["type"]>;

export function AssetNode(props: NodeProps<AssetFlowNode>) {
  const updateNodeData = useWorkflowStore((store) => store.updateNodeData);

  return (
    <NodeCard>
      <Handle position={Position.Right} type="source" />
      <NodeCardHeader>
        <NodeCardTitle>Asset</NodeCardTitle>
      </NodeCardHeader>
      <NodeCardPanel className="nodrag">
        {props.data.assets.length === 0 ? <p className="text-white/45 text-xs">No assets yet.</p> : null}
        {props.data.assets.map((asset, index) => (
          <div key={asset.assetId} className="rounded-lg border border-white/10 bg-white/4 px-2 py-1.5 text-xs">
            <span className="text-white/45">{index + 1}.</span> {asset.name ?? asset.assetId}
          </div>
        ))}
      </NodeCardPanel>
      <NodeCardFooter>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const nextData = structuredClone(props.data);
            nextData.assets.push({
              assetId: `asset-${crypto.randomUUID()}`,
              name: `Reference ${nextData.assets.length + 1}`,
            });
            updateNodeData<WorkflowAssetNode>(props.id, nextData);
          }}
        >
          <PlusIcon /> Add asset
        </Button>
      </NodeCardFooter>
    </NodeCard>
  );
}
