import { createContext, useContext } from "react";
import type { GeneratorHandleDefinition } from "~/lib/workflow/generator-models";
import type {
  GeneratorConfigValue,
  ImageGeneratorModelId,
  PromptDisplayMode,
  PromptVariable,
  VideoGeneratorModelId,
} from "~/lib/workflow/types";
import type { GeneratorIterationInfo } from "./graph";

export type StudioContextValue = {
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
