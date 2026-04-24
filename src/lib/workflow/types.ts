export const NANO_BANANA_PRO_MODEL_ID = "gemini-3-pro-image-preview";
export const VEO_31_MODEL_ID = "veo-3.1-fast-generate-001";
export const GEMINI_3_FLASH_PREVIEW_MODEL_ID = "gemini-3-flash-preview";

export const IMAGE_MODEL_IDS = [NANO_BANANA_PRO_MODEL_ID] as const;
export const VIDEO_MODEL_IDS = [VEO_31_MODEL_ID] as const;
export const LLM_MODEL_IDS = [GEMINI_3_FLASH_PREVIEW_MODEL_ID] as const;

export const IMAGE_ASPECT_RATIOS = [
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;

export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export const VIDEO_DURATIONS = [4, 6, 8] as const;
export const VIDEO_RESOLUTIONS = ["720p", "1080p"] as const;
export const LLM_THINKING_LEVELS = [
  "MINIMAL",
  "LOW",
  "MEDIUM",
  "HIGH",
] as const;
export const PROMPT_DISPLAY_MODES = [
  "source-value",
  "value",
  "source",
] as const;

export type AssetKind = "image" | "video";
export type AssetSource = "upload" | "generated";
export type WorkflowNodeStatus = "idle" | "running" | "success" | "error";
export type WorkflowNodeKind =
  | "list"
  | "prompt"
  | "asset"
  | "imageGenerator"
  | "videoGenerator"
  | "llmGenerator";
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export type VideoDuration = (typeof VIDEO_DURATIONS)[number];
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];
export type ImageGeneratorModelId = (typeof IMAGE_MODEL_IDS)[number];
export type VideoGeneratorModelId = (typeof VIDEO_MODEL_IDS)[number];
export type LlmGeneratorModelId = (typeof LLM_MODEL_IDS)[number];
export type LlmThinkingLevel = (typeof LLM_THINKING_LEVELS)[number];
export type GeneratorConfigValue = string | number | boolean | null;
export type GeneratorConfig = Record<string, GeneratorConfigValue>;
export type PromptDisplayMode = (typeof PROMPT_DISPLAY_MODES)[number];

export type PromptVariable = {
  key: string;
  label: string;
};

export type PromptResolvedVariable = PromptVariable & {
  value: string | null;
};

export type PromptInputHandle = {
  id: string;
  label: string;
  labelIndex?: number;
  color: string;
};

export type WorkflowAsset = {
  id: string;
  kind: AssetKind;
  source: AssetSource;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  url: string;
  storagePath: string | null;
  externalUri: string | null;
  model: string | null;
};

export type PromptNodeFields = {
  prompt: string;
  displayMode: PromptDisplayMode;
  variables: PromptVariable[];
};

export type ListNodeFields = {
  items: string[];
};

export type AssetNodeFields = {
  assetKind: AssetKind | null;
  assets: WorkflowAsset[];
};

export type WorkflowGeneratorResult = {
  lastPrompt: string;
  responseText: string | null;
  outputAssets: WorkflowAsset[];
};

export type WorkflowLlmResult = {
  lastPrompt: string;
  lastSystemPrompt: string;
  responseText: string | null;
};

type BaseGeneratorSettings<ModelId extends string> = {
  model: ModelId;
  mode: string | null;
  config: GeneratorConfig;
};

export type ImageGeneratorSettings =
  BaseGeneratorSettings<ImageGeneratorModelId>;
export type VideoGeneratorSettings =
  BaseGeneratorSettings<VideoGeneratorModelId>;
export type LlmGeneratorSettings = BaseGeneratorSettings<LlmGeneratorModelId>;

type BaseNodeData = {
  kind: WorkflowNodeKind;
  label: string;
  status: WorkflowNodeStatus;
  error: string | null;
};

export type PromptNodeData = BaseNodeData & {
  kind: "prompt";
  displayMode: PromptDisplayMode;
  prompt: string;
  variables: PromptResolvedVariable[];
  inputs: PromptInputHandle[];
};

export type ListNodeData = BaseNodeData &
  ListNodeFields & {
    kind: "list";
  };

export type AssetNodeData = BaseNodeData &
  AssetNodeFields & {
    kind: "asset";
  };

export type ImageGeneratorNodeData = BaseNodeData &
  WorkflowGeneratorResult &
  ImageGeneratorSettings & {
    kind: "imageGenerator";
  };

export type VideoGeneratorNodeData = BaseNodeData &
  WorkflowGeneratorResult &
  VideoGeneratorSettings & {
    kind: "videoGenerator";
  };

export type LlmGeneratorNodeData = BaseNodeData &
  WorkflowLlmResult &
  LlmGeneratorSettings & {
    kind: "llmGenerator";
  };

export type WorkflowNodeData =
  | PromptNodeData
  | ListNodeData
  | AssetNodeData
  | ImageGeneratorNodeData
  | VideoGeneratorNodeData
  | LlmGeneratorNodeData;

export type UploadAssetResponse = {
  asset: WorkflowAsset;
};

export type GenerateImageRequest = {
  model: ImageGeneratorModelId;
  mode: string | null;
  prompt: string;
  referenceImages?: WorkflowAsset[];
  aspectRatio?: ImageAspectRatio;
};

export type GenerateImageResponse = {
  assets: WorkflowAsset[];
  responseText: string | null;
  model: ImageGeneratorModelId;
};

export type GenerateVideoRequest = {
  model: VideoGeneratorModelId;
  mode: string | null;
  prompt: string;
  referenceImages?: WorkflowAsset[];
  aspectRatio?: VideoAspectRatio;
  durationSeconds?: VideoDuration;
  generateAudio?: boolean;
  resolution?: VideoResolution;
};

export type GenerateVideoResponse = {
  assets: WorkflowAsset[];
  model: VideoGeneratorModelId;
};

export type GenerateLlmRequest = {
  model: LlmGeneratorModelId;
  mode: string | null;
  prompt: string;
  systemPrompt?: string | null;
  referenceImages?: WorkflowAsset[];
  temperature?: number;
  thinkingLevel?: LlmThinkingLevel;
  maxOutputTokens?: number;
};

export type GenerateLlmUsage = {
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount: number;
  totalTokenCount: number;
};

export type GenerateLlmResponse = {
  model: LlmGeneratorModelId;
  responseText: string;
  usage: GenerateLlmUsage;
};

export function isGeneratorNodeKind(
  kind: WorkflowNodeKind,
): kind is "imageGenerator" | "videoGenerator" | "llmGenerator" {
  return (
    kind === "imageGenerator" ||
    kind === "videoGenerator" ||
    kind === "llmGenerator"
  );
}
