import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { Badge } from "~/components/ui/badge";
import { Card, CardHeader, CardPanel, CardTitle } from "~/components/ui/card";
import type { WorkflowImageGenerationNode } from "~/features/workflow/domain/graph";
import { useGenerationNodeEvaluation } from "../../_hooks/use-generation-node-evaluation";
import { SocketRow } from "../socket-row";

type ImageGenerationFlowNode = Node<WorkflowImageGenerationNode["data"], "imageGeneration">;

export function ImageGenerationNode(props: NodeProps<ImageGenerationFlowNode>) {
  const evaluation = useGenerationNodeEvaluation(props.id);

  const imageState = evaluation?.inputStates.find((inputState) => inputState.socketId === "image");
  const imageSocketCount = Math.min((imageState?.connectedEdgeCount ?? 0) + 1, 3);
  const imageSocketSlots = Array.from({ length: imageSocketCount }, (_, index) => ({
    id: `image:${index}`,
    label: `Image #${index + 1}`,
    muted: !imageState?.edgeStates[index],
  }));
  const outputPlaceholders = Array.from(
    { length: Math.max(evaluation?.summary.totalOutputCount ?? 1, 1) },
    (_, index) => `output-placeholder-${index + 1}`,
  );

  return (
    <Card>
      <Handle id="output" position={Position.Right} type="source" />
      <CardHeader>
        <CardTitle>Image Generation</CardTitle>
      </CardHeader>
      <CardPanel>
        <SocketRow id="prompt" label="Prompt" required />
        {imageSocketSlots.map((slot) => (
          <SocketRow key={slot.id} id={slot.id} label={slot.label} muted={slot.muted} />
        ))}
        <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="flex flex-wrap gap-2">
            <Badge variant={evaluation?.summary.status === "blocked" ? "error" : "success"}>
              {evaluation?.summary.status ?? "pending"}
            </Badge>
            <Badge variant="outline">{evaluation?.summary.branchCount ?? 0} branches</Badge>
            <Badge variant="outline">Batch size {props.data.branchBatchSize}</Badge>
            <Badge variant="outline">Cost {evaluation?.summary.generationCostCredits ?? 0}</Badge>
          </div>
          {evaluation?.errors.length ? (
            <p className="mt-2 text-red-200 text-xs">{evaluation.errors[0]?.kind.replaceAll("-", " ")}</p>
          ) : (
            <div className="mt-3 grid grid-cols-3 gap-2">
              {outputPlaceholders.map((placeholderId) => (
                <div key={placeholderId} className="aspect-square rounded-lg border border-white/10 bg-cyan-300/10" />
              ))}
            </div>
          )}
        </div>
      </CardPanel>
    </Card>
  );
}
