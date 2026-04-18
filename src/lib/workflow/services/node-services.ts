import type {
  ImageGeneratorWorkflowNode,
  PromptWorkflowNode,
  VideoGeneratorWorkflowNode,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import type {
  ImageAspectRatio,
  VideoAspectRatio,
  VideoDuration,
  VideoResolution,
  WorkflowAsset,
} from "~/lib/workflow/types";

export const PromptNodeService = {
  setPrompt(node: PromptWorkflowNode, prompt: string): PromptWorkflowNode {
    return {
      ...node,
      prompt,
    };
  },
};

export const ImageGeneratorService = {
  setAspectRatio(
    node: ImageGeneratorWorkflowNode,
    aspectRatio: ImageAspectRatio,
  ): ImageGeneratorWorkflowNode {
    return {
      ...node,
      aspectRatio,
    };
  },

  setExecutionResult(
    node: ImageGeneratorWorkflowNode,
    result: {
      lastPrompt: string;
      responseText: string | null;
      outputAssets: WorkflowAsset[];
    },
  ): ImageGeneratorWorkflowNode {
    return {
      ...node,
      lastPrompt: result.lastPrompt,
      responseText: result.responseText,
      outputAssets: result.outputAssets,
    };
  },
};

export const VideoGeneratorService = {
  setAspectRatio(
    node: VideoGeneratorWorkflowNode,
    aspectRatio: VideoAspectRatio,
  ): VideoGeneratorWorkflowNode {
    return {
      ...node,
      aspectRatio,
    };
  },

  setDuration(
    node: VideoGeneratorWorkflowNode,
    durationSeconds: VideoDuration,
  ): VideoGeneratorWorkflowNode {
    return {
      ...node,
      durationSeconds,
    };
  },

  setResolution(
    node: VideoGeneratorWorkflowNode,
    resolution: VideoResolution,
  ): VideoGeneratorWorkflowNode {
    return {
      ...node,
      resolution,
    };
  },

  setGenerateAudio(
    node: VideoGeneratorWorkflowNode,
    generateAudio: boolean,
  ): VideoGeneratorWorkflowNode {
    return {
      ...node,
      generateAudio,
    };
  },

  setExecutionResult(
    node: VideoGeneratorWorkflowNode,
    result: {
      lastPrompt: string;
      responseText: string | null;
      outputAssets: WorkflowAsset[];
    },
  ): VideoGeneratorWorkflowNode {
    return {
      ...node,
      lastPrompt: result.lastPrompt,
      responseText: result.responseText,
      outputAssets: result.outputAssets,
    };
  },
};

export const WorkflowNodeAssetService = {
  clearAssets(node: WorkflowDocumentNode): WorkflowDocumentNode {
    switch (node.kind) {
      case "image":
        return { ...node, asset: null };
      case "video":
        return { ...node, asset: null };
      case "imageIterator":
        return { ...node, assets: [] };
      case "imageGenerator":
      case "videoGenerator":
        return {
          ...node,
          outputAssets: [],
          responseText: null,
          lastPrompt: "",
        };
      default:
        return node;
    }
  },

  applyUploadedAssets(
    node: WorkflowDocumentNode,
    assets: WorkflowAsset[],
    options: { multiple: boolean },
  ): WorkflowDocumentNode {
    switch (node.kind) {
      case "image":
        return {
          ...node,
          asset: assets[0] ?? null,
        };
      case "video":
        return {
          ...node,
          asset: assets[0] ?? null,
        };
      case "imageIterator":
        return {
          ...node,
          assets: options.multiple
            ? [...node.assets, ...assets]
            : assets.slice(0, 1),
        };
      default:
        return node;
    }
  },
};
