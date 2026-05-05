import { createContext, useContext } from "react";
import type { GeneratorHandleDefinition } from "~/lib/workflow/generator-models";
import type { WorkflowRuntimeRunCostPreview } from "~/lib/workflow/services/workflow-client";
import type {
  GeneratorConfigValue,
  ImageGeneratorModelId,
  PromptDisplayMode,
  PromptVariable,
  VideoGeneratorModelId,
} from "~/lib/workflow/types";
import type { GeneratorIterationInfo } from "./graph";

export type StudioContextValue = {
  setListItems: (nodeId: string, items: string[]) => void;
  setPrompt: (nodeId: string, prompt: string) => void;
  setPromptDisplayMode: (
    nodeId: string,
    displayMode: PromptDisplayMode,
  ) => void;
  addPromptVariable: (nodeId: string) => PromptVariable | null;
  uploadFilesToNode: (nodeId: string, files: File[]) => Promise<void>;
  clearNodeAssets: (nodeId: string) => void;
  getGeneratorIterationInfo: (nodeId: string) => GeneratorIterationInfo;
  getGeneratorInputs: (nodeId: string) => GeneratorHandleDefinition[];
  setOutputReorderMode: (nodeId: string, mode: "shift" | "manual") => void;
  setOutputReorderOrder: (nodeId: string, order: number[]) => void;
  setOutputReorderShift: (nodeId: string, shift: number) => void;
  setImageGeneratorModel: (
    nodeId: string,
    model: ImageGeneratorModelId,
  ) => void;
  setVideoGeneratorModel: (
    nodeId: string,
    model: VideoGeneratorModelId,
  ) => void;
  setImageGeneratorMode: (nodeId: string, mode: string) => void;
  setVideoGeneratorMode: (nodeId: string, mode: string) => void;
  setImageGeneratorConfigValue: (
    nodeId: string,
    key: string,
    value: GeneratorConfigValue,
  ) => void;
  setLlmGeneratorConfigValue: (
    nodeId: string,
    key: string,
    value: GeneratorConfigValue,
  ) => void;
  setVideoGeneratorConfigValue: (
    nodeId: string,
    key: string,
    value: GeneratorConfigValue,
  ) => void;
  setGeneratorReviewEnabled: (nodeId: string, enabled: boolean) => void;
  previewRunNode: (nodeId: string) => Promise<WorkflowRuntimeRunCostPreview>;
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
