export const NANO_BANANA_PRO_MODEL_ID = "gemini-3-pro-image-preview";
export const VEO_31_FAST_MODEL_ID = "veo-3.1-fast-generate-001";
export const GEMINI_3_FLASH_PREVIEW_MODEL_ID = "gemini-3-flash-preview";

export const IMAGE_MODEL_IDS = [NANO_BANANA_PRO_MODEL_ID] as const;
export const VIDEO_MODEL_IDS = [VEO_31_FAST_MODEL_ID] as const;
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
export const ASSET_KINDS = ["image", "video", "text"] as const;
export const MEDIA_ASSET_KINDS = ["image", "video"] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];
export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number];
export type AssetSource = "upload" | "generated";
export type WorkflowNodeStatus =
  | "idle"
  | "running"
  | "waiting"
  | "success"
  | "error";
export type WorkflowNodeKind =
  | "list"
  | "prompt"
  | "asset"
  | "outputReorder"
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
export type OutputReorderMode = "shift" | "manual";
export type OutputTransformValueType = "text" | "image" | "video" | null;

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

export type StagedGeneratedMediaArtifact = {
  id: string;
  kind: MediaAssetKind;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  model: string | null;
} & (
  | {
      storageProvider: "local-staged";
      stagedStoragePath: string;
      promotedStoragePath: string;
      externalUri: null;
    }
  | {
      storageProvider: "external-staged";
      externalUri: string;
      stagedStoragePath?: null;
      promotedStoragePath?: null;
    }
);

export type PromptNodeFields = {
  prompt: string;
  displayMode: PromptDisplayMode;
  variables: PromptVariable[];
};

export type ListNodeFields = {
  items: string[];
};

export type AssetNodeFields = {
  assetKind: MediaAssetKind | null;
  assets: WorkflowAsset[];
};

export type OutputReorderNodeFields = {
  mode: OutputReorderMode;
  order: number[];
  shift: number;
  valueType: OutputTransformValueType;
};

export type WorkflowOutputReviewStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "regenerating";

export type WorkflowReviewOutput = {
  executionId: string | null;
  outputIndex: number;
  status: WorkflowOutputReviewStatus;
  attempt: number;
  assets: WorkflowAsset[];
  taskRunId?: string;
  text: string | null;
};

export type WorkflowReviewState = {
  sourceNodeId: string | null;
  updatedAt: string | null;
  valueType: OutputTransformValueType;
  outputs: WorkflowReviewOutput[];
};

export type GeneratorReviewFields = {
  reviewEnabled: boolean;
  review: WorkflowReviewState;
};

export type WorkflowGeneratorResult = {
  lastPrompt: string;
  outputs: WorkflowAsset[][];
};

export type WorkflowLlmResult = {
  lastPrompt: string;
  lastSystemPrompt: string;
  outputs: string[];
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

export type OutputReorderNodeData = BaseNodeData &
  OutputReorderNodeFields & {
    kind: "outputReorder";
  };

export type ImageGeneratorNodeData = BaseNodeData &
  WorkflowGeneratorResult &
  GeneratorReviewFields &
  ImageGeneratorSettings & {
    kind: "imageGenerator";
  };

export type VideoGeneratorNodeData = BaseNodeData &
  WorkflowGeneratorResult &
  GeneratorReviewFields &
  VideoGeneratorSettings & {
    kind: "videoGenerator";
  };

export type LlmGeneratorNodeData = BaseNodeData &
  WorkflowLlmResult &
  GeneratorReviewFields &
  LlmGeneratorSettings & {
    kind: "llmGenerator";
  };

export type WorkflowNodeData =
  | PromptNodeData
  | ListNodeData
  | AssetNodeData
  | OutputReorderNodeData
  | ImageGeneratorNodeData
  | VideoGeneratorNodeData
  | LlmGeneratorNodeData;

export type UploadAssetResponse = {
  asset: WorkflowAsset;
};

export type GenerateImageRequest = {
  idempotencyKey?: string | null;
  model: ImageGeneratorModelId;
  mode: string | null;
  prompt: string;
  referenceImages?: WorkflowAsset[];
  aspectRatio?: ImageAspectRatio;
};

export type GenerateImageResponse = {
  assets: StagedGeneratedMediaArtifact[];
  model: ImageGeneratorModelId;
};

export type GenerateVideoRequest = {
  idempotencyKey?: string | null;
  model: VideoGeneratorModelId;
  mode: string | null;
  prompt: string;
  firstFrame?: WorkflowAsset;
  lastFrame?: WorkflowAsset;
  referenceImages?: WorkflowAsset[];
  aspectRatio?: VideoAspectRatio;
  durationSeconds?: VideoDuration;
  generateAudio?: boolean;
  resolution?: VideoResolution;
};

export type GenerateVideoResponse = {
  assets: StagedGeneratedMediaArtifact[];
  model: VideoGeneratorModelId;
};

export type GenerateLlmRequest = {
  idempotencyKey?: string | null;
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
