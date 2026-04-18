import { createContext, useContext } from "react";

import type {
  ImageAspectRatio,
  VideoAspectRatio,
  VideoDuration,
  VideoResolution,
} from "~/lib/workflow/types";
import type { GeneratorIterationInfo, HandleDefinition } from "./graph";

export type StudioContextValue = {
  setPrompt: (nodeId: string, prompt: string) => void;
  uploadFilesToNode: (
    nodeId: string,
    files: File[],
    options: { kind: "image" | "video"; multiple: boolean },
  ) => Promise<void>;
  clearNodeAssets: (nodeId: string) => void;
  getGeneratorIterationInfo: (nodeId: string) => GeneratorIterationInfo;
  getGeneratorImageInputs: (nodeId: string) => HandleDefinition[];
  setImageGeneratorAspectRatio: (
    nodeId: string,
    aspectRatio: ImageAspectRatio,
  ) => void;
  setVideoGeneratorAspectRatio: (
    nodeId: string,
    aspectRatio: VideoAspectRatio,
  ) => void;
  setVideoGeneratorDuration: (
    nodeId: string,
    durationSeconds: VideoDuration,
  ) => void;
  setVideoGeneratorResolution: (
    nodeId: string,
    resolution: VideoResolution,
  ) => void;
  setVideoGeneratorGenerateAudio: (
    nodeId: string,
    generateAudio: boolean,
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
