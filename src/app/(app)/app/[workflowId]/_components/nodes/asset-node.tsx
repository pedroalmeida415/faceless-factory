"use client";

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { PlusIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardHeader, CardPanel, CardTitle } from "~/components/ui/card";
import type { WorkflowAssetNode, WorkflowNode } from "~/features/workflow/domain/graph";
import { useWorkflowStore } from "../../_hooks/use-workflow-store";

type AssetFlowNode = Node<WorkflowAssetNode["data"], "asset">;

export function AssetNode(props: NodeProps<AssetFlowNode>) {
  const updateNode = useWorkflowStore((store) => store.updateNode);

  return (
    <Card>
      <Handle position={Position.Right} type="source" />
      <CardHeader>
        <CardTitle>Asset</CardTitle>
      </CardHeader>
      <CardPanel className="nodrag">
        {props.data.assets.length === 0 ? <p className="text-white/45 text-xs">No assets yet.</p> : null}
        {props.data.assets.map((asset, index) => (
          <div key={asset.assetId} className="rounded-lg border border-white/10 bg-white/4 px-2 py-1.5 text-xs">
            <span className="text-white/45">{index + 1}.</span> {asset.name ?? asset.assetId}
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            updateNode(props.id, (candidate: WorkflowNode) =>
              candidate.type === "asset"
                ? {
                    ...candidate,
                    data: {
                      assets: [
                        ...candidate.data.assets,
                        {
                          assetId: `asset-${crypto.randomUUID()}`,
                          name: `Reference ${candidate.data.assets.length + 1}`,
                        },
                      ],
                    },
                  }
                : candidate,
            )
          }
        >
          <PlusIcon /> Add mock asset
        </Button>
      </CardPanel>
    </Card>
  );
}
