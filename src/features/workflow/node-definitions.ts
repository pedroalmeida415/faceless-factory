import type {
  PromptDisplayMode,
  WorkflowNodeKind,
} from "~/features/workflow/types";

export const PROMPT_INPUT_HANDLE_ID = "prompt";
export const OUTPUT_REORDER_INPUT_HANDLE_ID = "input";
export const OUTPUT_REORDER_OUTPUT_HANDLE_ID = "output";
export const PROMPT_VARIABLE_PATTERN =
  /\{\{([a-zA-Z][a-zA-Z0-9]*)(?::[^}]*)?\}\}/g;
export const PROMPT_VARIABLE_HANDLE_COLOR = "#f59e0b";
export const DEFAULT_PROMPT_DISPLAY_MODE: PromptDisplayMode = "source-value";

export type WorkflowValueType = "text" | "image" | "video";

export type HandleDefinition = {
  id: string;
  label: string;
  labelIndex?: number;
  color: string;
};

export function formatNodeTitle(kind: WorkflowNodeKind) {
  switch (kind) {
    case "list":
      return "List";
    case "prompt":
      return "Prompt";
    case "asset":
      return "Asset";
    case "outputReorder":
      return "Output Reorder";
    case "imageGenerator":
      return "Image Gen";
    case "videoGenerator":
      return "Video Gen";
    case "llmGenerator":
      return "Run LLM";
  }
}

export function getNodeOutputHandleId(kind: WorkflowNodeKind) {
  switch (kind) {
    case "list":
      return "text";
    case "prompt":
      return "text";
    case "asset":
      return "asset";
    case "outputReorder":
      return OUTPUT_REORDER_OUTPUT_HANDLE_ID;
    case "imageGenerator":
      return "images";
    case "videoGenerator":
      return "videos";
    case "llmGenerator":
      return "text";
  }
}
