import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { CircleAlertIcon } from "lucide-react";
import { NodeCard, NodeCardFooter, NodeCardHeader, NodeCardPanel, NodeCardTitle } from "~/components/node-card";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { CardDescription } from "~/components/ui/card";
import { ScrollArea } from "~/components/ui/scroll-area";
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
  const branchBatchSize = evaluation?.summary.branchBatchSize ?? props.data.branchBatchSize;
  const status = evaluation?.summary.status ?? "blocked";
  const batchItemNumbers = Array.from({ length: branchBatchSize }, (_, batchItemIndex) => batchItemIndex + 1);

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

      inputSocketRows.push({
        id: socket.id,
        label: `${socket.label} (${state?.connectedEdgeCount ?? 0}/${socket.capacity})`,
        muted: !state?.connectedEdgeCount,
      });
    }
  }

  return (
    <NodeCard>
      <NodeCardHeader>
        <NodeCardTitle>Image Generation</NodeCardTitle>
        <CardDescription>
          {model?.displayName ?? props.data.modelId} / Batch size {branchBatchSize}
        </CardDescription>
      </NodeCardHeader>
      <NodeCardPanel>
        <ScrollArea className="nodrag nopan nowheel h-96 rounded-xl border bg-muted" scrollFade>
          <div className="flex h-full flex-col gap-4 p-3">
            {evaluation && status === "valid" ? (
              evaluation.branches.map((branch) => (
                <section key={branch.branchIndex} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3 px-1">
                    <h3 className="font-medium text-sm">Branch {branch.branchIndex + 1}</h3>
                    <span className="text-muted-foreground text-xs">
                      {branchBatchSize} {branchBatchSize === 1 ? "image" : "images"}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {batchItemNumbers.map((batchItemNumber) => (
                      <div
                        key={`branch-${branch.branchIndex + 1}-image-${batchItemNumber}`}
                        aria-label={`Branch ${branch.branchIndex + 1} image ${batchItemNumber}`}
                        className="aspect-square rounded-lg border border-dashed bg-background/60 p-2"
                        role="img"
                      >
                        <div className="flex h-full items-end rounded-md bg-muted p-2 text-muted-foreground text-xs">
                          Image {batchItemNumber}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))
            ) : (
              <Alert className="align-bottom" variant="error">
                <CircleAlertIcon />
                <AlertTitle>Blocked</AlertTitle>
                <AlertDescription>
                  {evaluation?.errors[0]?.kind.replaceAll("-", " ") ?? "Waiting for graph evaluation."}
                </AlertDescription>
              </Alert>
            )}
          </div>
        </ScrollArea>
      </NodeCardPanel>
      <NodeCardFooter>
        <Button size="xl" className="w-full">
          Run
        </Button>
      </NodeCardFooter>
      {inputSocketRows.map((socket, index) => (
        <SocketRow
          key={socket.id}
          handleTop={80 + index * 24}
          id={socket.id}
          label={socket.label}
          muted={socket.muted}
        />
      ))}
      <Handle id="output" position={Position.Right} type="source" />
    </NodeCard>
  );
}
