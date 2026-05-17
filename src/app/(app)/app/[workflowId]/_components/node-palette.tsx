"use client";

import { ImageIcon, ListIcon, SparklesIcon, TypeIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { WorkflowNode } from "~/features/workflow/domain/graph";
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

  return (
    <div className="absolute top-3 left-3 z-10 flex flex-col gap-0.5 rounded-xl border border-white/10 bg-black/60 p-1 shadow-lg backdrop-blur">
      {NODE_TOOLS.map((tool) => {
        const Icon = tool.icon;

        return (
          <Tooltip key={tool.id}>
            <TooltipTrigger
              aria-label={`Add ${tool.label}`}
              className={cn(
                "grid size-9 place-items-center rounded-md text-white/70 transition-colors",
                "hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70",
              )}
              onClick={() => addNodeToGraph(tool.id)}
            >
              <Icon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="right">
              <span className="flex items-center gap-2">
                Add {tool.label}
                <span className="rounded border border-white/10 bg-white/10 px-1 font-mono text-[10px] text-white/60">
                  {tool.shortcut}
                </span>
              </span>
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
