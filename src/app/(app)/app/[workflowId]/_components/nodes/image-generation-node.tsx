import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { NodeCard, NodeCardFooter, NodeCardHeader, NodeCardPanel, NodeCardTitle } from "~/components/node-card";
import { Button } from "~/components/ui/button";
import type { WorkflowImageGenerationNode } from "~/features/workflow/domain/graph";
import { WORKFLOW_MODEL_CATALOG } from "~/features/workflow/domain/model-catalog";
import { useGenerationNodeEvaluation } from "../../_hooks/use-graph-evaluation";
import { SocketRow } from "../socket-row";

type ImageGenerationFlowNode = Node<WorkflowImageGenerationNode["data"], WorkflowImageGenerationNode["type"]>;
type InputSocketRow = {
  readonly id: string;
  readonly label: string;
  readonly muted: boolean;
};

export function ImageGenerationNode(props: NodeProps<ImageGenerationFlowNode>) {
  const evaluation = useGenerationNodeEvaluation(props.id);
  const model = WORKFLOW_MODEL_CATALOG.find((candidate) => candidate.modelId === props.data.modelId);

  const inputSocketRows: InputSocketRow[] = [];

  if (model) {
    for (const socket of model.inputSockets) {
      const state = evaluation?.inputStates.find((inputState) => inputState.socketId === socket.id);

      if (!socket.repeatable) {
        inputSocketRows.push({
          id: socket.id,
          label: socket.label,
          muted: false,
        });
        continue;
      }

      for (let index = 0; index < socket.capacity; index += 1) {
        inputSocketRows.push({
          id: `${socket.id}:${index}`,
          label: `${socket.label} #${index + 1}`,
          muted: !state?.edgeStates[index],
        });
      }
    }
  }

  return (
    <NodeCard className="group">
      <Handle id="output" position={Position.Right} type="source" />
      {inputSocketRows.map((socket, index) => (
        <SocketRow
          key={socket.id}
          handleTop={60 + index * 24}
          id={socket.id}
          label={socket.label}
          muted={socket.muted}
        />
      ))}
      <NodeCardHeader>
        <NodeCardTitle>Image Generation</NodeCardTitle>
      </NodeCardHeader>
      <NodeCardPanel>
        <div className="h-96 rounded-xl border border-white/10 bg-black/20 p-3">
          {/* <div className="flex flex-wrap gap-2">
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
          )} */}
        </div>
      </NodeCardPanel>
      <NodeCardFooter>
        <Button size="xl" className="w-full">
          Run
        </Button>
      </NodeCardFooter>
    </NodeCard>
  );
}
