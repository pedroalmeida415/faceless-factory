"use client";

import { useStoreApi } from "@xyflow/react";
import { ImageIcon, ListIcon, SparklesIcon, TypeIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { WorkflowEdge, WorkflowNode } from "~/features/workflow/domain/graph";
import { cn } from "~/lib/utils";
import { useWorkflowStore } from "../_hooks/use-workflow-store";

const NODE_TOOLS: {
  readonly id: WorkflowNode["type"];
  readonly icon: typeof TypeIcon;
  readonly label: string;
  readonly shortcut: string;
}[] = [
  { id: "prompt", icon: TypeIcon, label: "Prompt", shortcut: "P" },
  { id: "list", icon: ListIcon, label: "List", shortcut: "L" },
  { id: "asset", icon: ImageIcon, label: "Asset", shortcut: "A" },
  { id: "imageGeneration", icon: SparklesIcon, label: "Image Generation", shortcut: "G" },
];

export function NodePalette() {
  const addNodeToGraph = useWorkflowStore((store) => store.addNodeToGraph);
  const reactFlowStore = useStoreApi<WorkflowNode, WorkflowEdge>();

  const addNodeAtViewportCenter = (type: WorkflowNode["type"]) => {
    const { height, transform, width } = reactFlowStore.getState();
    const [translateX, translateY, zoom] = transform;

    if (width <= 0 || height <= 0) {
      return;
    }

    addNodeToGraph({
      position: {
        x: (width / 2 - translateX) / zoom,
        y: (height / 2 - translateY) / zoom,
      },
      type,
    });
  };

  return (
    <div className="absolute top-3 left-3 z-10 flex flex-col gap-0.5 rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg/5 backdrop-blur">
      {NODE_TOOLS.map((tool) => {
        const Icon = tool.icon;

        return (
          <Tooltip key={tool.id}>
            <TooltipTrigger
              aria-label={`Add ${tool.label}`}
              className={cn(
                "grid size-9 place-items-center rounded-md text-muted-foreground transition-colors",
                "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              onClick={() => addNodeAtViewportCenter(tool.id)}
            >
              <Icon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="right">
              <span className="flex items-center gap-2">
                Add {tool.label}
                <Badge size="sm" variant="outline">
                  {tool.shortcut}
                </Badge>
              </span>
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
