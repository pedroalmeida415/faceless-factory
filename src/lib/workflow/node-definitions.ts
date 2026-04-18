import {
  isGeneratorNodeKind,
  type WorkflowNodeKind,
} from "~/lib/workflow/types";

export const PROMPT_INPUT_HANDLE_ID = "prompt";
const GENERATOR_IMAGE_INPUT_HANDLE_PREFIX = "image-input-";
const LEGACY_GENERATOR_IMAGE_INPUT_HANDLE_IDS = new Set(["image", "images"]);
const GENERATOR_IMAGE_INPUT_COLOR = "#38bdf8";

export type WorkflowValueType = "text" | "image" | "video";

export type HandleDefinition = {
  id: string;
  label: string;
  color: string;
};

export function formatNodeTitle(kind: WorkflowNodeKind) {
  switch (kind) {
    case "prompt":
      return "Prompt";
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "imageIterator":
      return "Image Iterator";
    case "imageGenerator":
      return "Image Generator";
    case "videoGenerator":
      return "Video Generator";
  }
}

export function makeGeneratorImageHandleId(index: number) {
  return `${GENERATOR_IMAGE_INPUT_HANDLE_PREFIX}${index}`;
}

export function isGeneratorImageHandle(handleId: string | null | undefined) {
  if (!handleId) {
    return false;
  }

  return (
    LEGACY_GENERATOR_IMAGE_INPUT_HANDLE_IDS.has(handleId) ||
    handleId.startsWith(GENERATOR_IMAGE_INPUT_HANDLE_PREFIX)
  );
}

export function getGeneratorImageInputColor() {
  return GENERATOR_IMAGE_INPUT_COLOR;
}

export function getNodeOutputHandleId(kind: WorkflowNodeKind) {
  switch (kind) {
    case "prompt":
      return "text";
    case "image":
      return "image";
    case "video":
      return "video";
    case "imageIterator":
    case "imageGenerator":
      return "images";
    case "videoGenerator":
      return "videos";
  }
}

export function getNodeOutputValueType(
  kind: WorkflowNodeKind,
  handleId: string | null | undefined,
): WorkflowValueType | null {
  const normalizedHandleId = handleId ?? getNodeOutputHandleId(kind);

  switch (kind) {
    case "prompt":
      return normalizedHandleId === "text" ? "text" : null;
    case "image":
      return normalizedHandleId === "image" ? "image" : null;
    case "video":
      return normalizedHandleId === "video" ? "video" : null;
    case "imageIterator":
    case "imageGenerator":
      return normalizedHandleId === "images" ? "image" : null;
    case "videoGenerator":
      return normalizedHandleId === "videos" ? "video" : null;
  }
}

export function getNodeInputValueType(
  kind: WorkflowNodeKind,
  handleId: string | null | undefined,
): WorkflowValueType | null {
  if (!isGeneratorNodeKind(kind) || !handleId) {
    return null;
  }

  if (handleId === PROMPT_INPUT_HANDLE_ID) {
    return "text";
  }

  return isGeneratorImageHandle(handleId) ? "image" : null;
}
