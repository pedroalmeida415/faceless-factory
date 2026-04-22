import type { WorkflowNodeKind } from "~/lib/workflow/types";

export const PROMPT_INPUT_HANDLE_ID = "prompt";

export type WorkflowValueType = "text" | "image" | "video";

export type HandleDefinition = {
  id: string;
  label: string;
  labelIndex?: number;
  color: string;
};

export function formatNodeTitle(kind: WorkflowNodeKind) {
  switch (kind) {
    case "prompt":
      return "Prompt";
    case "asset":
      return "Asset";
    case "imageGenerator":
      return "Image Gen";
    case "videoGenerator":
      return "Video Generator";
    case "llmGenerator":
      return "Run LLM";
  }
}

export function getNodeOutputHandleId(kind: WorkflowNodeKind) {
  switch (kind) {
    case "prompt":
      return "text";
    case "asset":
      return "asset";
    case "imageGenerator":
      return "images";
    case "videoGenerator":
      return "videos";
    case "llmGenerator":
      return "text";
  }
}
