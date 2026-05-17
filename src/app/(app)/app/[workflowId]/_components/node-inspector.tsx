"use client";

import { Drawer, DrawerDescription, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "~/components/ui/drawer";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import type { WorkflowNode } from "~/features/workflow/domain/graph";
import { NANO_BANANA_PRO_MODEL } from "~/features/workflow/domain/model-catalog";
import { useGenerationNodeEvaluation } from "../_hooks/use-generation-node-evaluation";
import { useSelectedGenerationNode } from "../_hooks/use-selected-generation-node";
import { useWorkflowStore } from "../_hooks/use-workflow-store";

export function NodeInspector() {
  const onClose = useWorkflowStore((store) => store.closeNodeInspector);
  const onUpdateNode = useWorkflowStore((store) => store.updateNode);
  const node = useSelectedGenerationNode();
  const evaluation = useGenerationNodeEvaluation(node?.id ?? null);
  const open = Boolean(node);

  return (
    <Drawer modal={false} onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open} position="right">
      <DrawerPopup
        className="pointer-events-auto w-72"
        showBackdrop={false}
        showCloseButton
        variant="straight"
        viewportClassName="pointer-events-none"
      >
        <DrawerHeader>
          <DrawerTitle>Node Inspector</DrawerTitle>
          <DrawerDescription>Configure the selected image generation node.</DrawerDescription>
        </DrawerHeader>
        <DrawerPanel className="grid gap-5">
          {node ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="workflow-model">Model</Label>
                <Input id="workflow-model" readOnly value={NANO_BANANA_PRO_MODEL.displayName} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="workflow-resolution">Resolution</Label>
                <Select
                  id="workflow-resolution"
                  onValueChange={(value) =>
                    onUpdateNode(node.id, (candidate: WorkflowNode) =>
                      candidate.type === "imageGeneration" && value !== null
                        ? {
                            ...candidate,
                            data: {
                              ...candidate.data,
                              config: { ...candidate.data.config, resolution: value },
                            },
                          }
                        : candidate,
                    )
                  }
                  value={String(node.data.config.resolution ?? NANO_BANANA_PRO_MODEL.defaultConfig.resolution)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {NANO_BANANA_PRO_MODEL.configFields[0]?.options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="workflow-batch-size">Batch size</Label>
                <Select
                  id="workflow-batch-size"
                  onValueChange={(value) =>
                    onUpdateNode(node.id, (candidate: WorkflowNode) =>
                      candidate.type === "imageGeneration"
                        ? {
                            ...candidate,
                            data: { ...candidate.data, branchBatchSize: Number(value) },
                          }
                        : candidate,
                    )
                  }
                  value={String(node.data.branchBatchSize)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {[1, 2, 3, 4].map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p>Number of images generated per Branch.</p>
              </div>
              <div>
                <div className="flex justify-between">
                  <span>Branches</span>
                  <span>{evaluation?.summary.branchCount ?? 0}</span>
                </div>
                <div className="mt-2 flex justify-between">
                  <span>Outputs</span>
                  <span>{evaluation?.summary.totalOutputCount ?? 0}</span>
                </div>
                <div className="mt-2 flex justify-between">
                  <span>Cost</span>
                  <span>{evaluation?.summary.generationCostCredits ?? 0} credits</span>
                </div>
              </div>
            </>
          ) : null}
        </DrawerPanel>
      </DrawerPopup>
    </Drawer>
  );
}
