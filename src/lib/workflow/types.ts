export const NANO_BANANA_PRO_MODEL_ID = "gemini-3-pro-image-preview";
export const VEO_31_MODEL_ID = "veo-3.1-fast-generate-001";

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

export type AssetKind = "image" | "video";
export type AssetSource = "upload" | "generated";
export type WorkflowNodeStatus = "idle" | "running" | "success" | "error";
export type WorkflowNodeKind =
  | "prompt"
  | "image"
  | "video"
  | "imageIterator"
  | "imageGenerator"
  | "videoGenerator";
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export type VideoDuration = (typeof VIDEO_DURATIONS)[number];
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

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
};

export type ImageNodeFields = {
  asset: WorkflowAsset | null;
};

export type VideoNodeFields = {
  asset: WorkflowAsset | null;
};

export type ImageIteratorNodeFields = {
  assets: WorkflowAsset[];
};

export type WorkflowGeneratorResult = {
  lastPrompt: string;
  responseText: string | null;
  outputAssets: WorkflowAsset[];
};

export type ImageGeneratorSettings = {
  model: typeof NANO_BANANA_PRO_MODEL_ID;
  aspectRatio: ImageAspectRatio;
};

export type VideoGeneratorSettings = {
  model: typeof VEO_31_MODEL_ID;
  aspectRatio: VideoAspectRatio;
  durationSeconds: VideoDuration;
  generateAudio: boolean;
  resolution: VideoResolution;
};

type BaseNodeData = {
  kind: WorkflowNodeKind;
  label: string;
  status: WorkflowNodeStatus;
  error: string | null;
};

export type PromptNodeData = BaseNodeData &
  PromptNodeFields & {
    kind: "prompt";
  };

export type ImageNodeData = BaseNodeData &
  ImageNodeFields & {
    kind: "image";
  };

export type VideoNodeData = BaseNodeData &
  VideoNodeFields & {
    kind: "video";
  };

export type ImageIteratorNodeData = BaseNodeData &
  ImageIteratorNodeFields & {
    kind: "imageIterator";
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

export type WorkflowNodeData =
  | PromptNodeData
  | ImageNodeData
  | VideoNodeData
  | ImageIteratorNodeData
  | ImageGeneratorNodeData
  | VideoGeneratorNodeData;

export type UploadAssetResponse = {
  asset: WorkflowAsset;
};

export type GenerateImageRequest = {
  prompt: string;
  referenceImages?: WorkflowAsset[];
  aspectRatio?: ImageAspectRatio;
};

export type GenerateImageResponse = {
  assets: WorkflowAsset[];
  responseText: string | null;
  model: typeof NANO_BANANA_PRO_MODEL_ID;
};

export type GenerateVideoRequest = {
  prompt: string;
  referenceImage?: WorkflowAsset | null;
  referenceImages?: WorkflowAsset[];
  aspectRatio?: VideoAspectRatio;
  durationSeconds?: VideoDuration;
  generateAudio?: boolean;
  resolution?: VideoResolution;
};

export type GenerateVideoResponse = {
  assets: WorkflowAsset[];
  model: typeof VEO_31_MODEL_ID;
};

export function isGeneratorNodeKind(
  kind: WorkflowNodeKind,
): kind is "imageGenerator" | "videoGenerator" {
  return kind === "imageGenerator" || kind === "videoGenerator";
}

export function isImageSourceNodeKind(
  kind: WorkflowNodeKind,
): kind is "image" | "imageIterator" | "imageGenerator" {
  return (
    kind === "image" || kind === "imageIterator" || kind === "imageGenerator"
  );
}

export function isVideoSourceNodeKind(
  kind: WorkflowNodeKind,
): kind is "video" | "videoGenerator" {
  return kind === "video" || kind === "videoGenerator";
}
