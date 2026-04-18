import { createContext, useContext } from "react";

import type { WorkflowNodeData } from "~/lib/workflow/types";
import type { GeneratorIterationInfo, HandleDefinition } from "./graph";

export type StudioContextValue = {
  updateNodeData: (
    nodeId: string,
    updater: (data: WorkflowNodeData) => WorkflowNodeData,
  ) => void;
  uploadFilesToNode: (
    nodeId: string,
    files: File[],
    options: { kind: "image" | "video"; multiple: boolean },
  ) => Promise<void>;
  clearNodeAssets: (nodeId: string) => void;
  getGeneratorIterationInfo: (nodeId: string) => GeneratorIterationInfo;
  getGeneratorImageInputs: (nodeId: string) => HandleDefinition[];
  runNode: (nodeId: string) => Promise<void>;
};

export const StudioContext = createContext<StudioContextValue | null>(null);

export function useStudioContext() {
  const context = useContext(StudioContext);
  if (!context) {
    throw new Error("WorkflowStudio context missing.");
  }
  return context;
}
