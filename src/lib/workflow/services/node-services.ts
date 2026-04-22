import type {
  ImageGeneratorWorkflowNode,
  LlmGeneratorWorkflowNode,
  PromptWorkflowNode,
  VideoGeneratorWorkflowNode,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import {
  setGeneratorConfigValue,
  setImageGeneratorMode,
  setImageGeneratorModel,
  setVideoGeneratorMode,
  setVideoGeneratorModel,
} from "~/lib/workflow/generator-models";
import { setLlmGeneratorConfigValue } from "~/lib/workflow/llm-models";
import type {
  AssetKind,
  GeneratorConfigValue,
  ImageGeneratorModelId,
  VideoGeneratorModelId,
  WorkflowAsset,
} from "~/lib/workflow/types";

function getBatchAssetKind(assets: WorkflowAsset[]) {
  const firstAsset = assets[0];
  if (!firstAsset) {
    return null;
  }

  if (!assets.every((asset) => asset.kind === firstAsset.kind)) {
    throw new WorkflowValidationError({
      message: "Asset nodes only accept one media type at a time.",
    });
  }

  return firstAsset.kind;
}

function assertCompatibleAssetKind(
  expectedKind: AssetKind | null,
  nextKind: AssetKind | null,
) {
  if (!expectedKind || !nextKind || expectedKind === nextKind) {
    return;
  }

  throw new WorkflowValidationError({
    message: `This asset node is locked to ${expectedKind}s. Clear it before switching media type.`,
  });
}

export const PromptNodeService = {
  setPrompt(node: PromptWorkflowNode, prompt: string): PromptWorkflowNode {
    return {
      ...node,
      prompt,
    };
  },
};

export const ImageGeneratorService = {
  setModel(
    node: ImageGeneratorWorkflowNode,
    model: ImageGeneratorModelId,
  ): ImageGeneratorWorkflowNode {
    return {
      ...node,
      ...setImageGeneratorModel(model),
    };
  },

  setMode(
    node: ImageGeneratorWorkflowNode,
    mode: string,
  ): ImageGeneratorWorkflowNode {
    return {
      ...node,
      ...setImageGeneratorMode(node, mode),
    };
  },

  setConfigValue(
    node: ImageGeneratorWorkflowNode,
    key: string,
    value: GeneratorConfigValue,
  ): ImageGeneratorWorkflowNode {
    return {
      ...node,
      config: setGeneratorConfigValue(node.config, key, value),
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
  setModel(
    node: VideoGeneratorWorkflowNode,
    model: VideoGeneratorModelId,
  ): VideoGeneratorWorkflowNode {
    return {
      ...node,
      ...setVideoGeneratorModel(model),
    };
  },

  setMode(
    node: VideoGeneratorWorkflowNode,
    mode: string,
  ): VideoGeneratorWorkflowNode {
    return {
      ...node,
      ...setVideoGeneratorMode(node, mode),
    };
  },

  setConfigValue(
    node: VideoGeneratorWorkflowNode,
    key: string,
    value: GeneratorConfigValue,
  ): VideoGeneratorWorkflowNode {
    return {
      ...node,
      config: setGeneratorConfigValue(node.config, key, value),
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

export const LlmGeneratorService = {
  setConfigValue(
    node: LlmGeneratorWorkflowNode,
    key: string,
    value: GeneratorConfigValue,
  ): LlmGeneratorWorkflowNode {
    return {
      ...node,
      config: setLlmGeneratorConfigValue(node.config, key, value),
    };
  },

  setExecutionResult(
    node: LlmGeneratorWorkflowNode,
    result: {
      lastPrompt: string;
      lastSystemPrompt: string;
      responseText: string | null;
    },
  ): LlmGeneratorWorkflowNode {
    return {
      ...node,
      lastPrompt: result.lastPrompt,
      lastSystemPrompt: result.lastSystemPrompt,
      responseText: result.responseText,
    };
  },
};

export const WorkflowNodeAssetService = {
  clearAssets(node: WorkflowDocumentNode): WorkflowDocumentNode {
    switch (node.kind) {
      case "asset":
        return {
          ...node,
          assets: [],
        };
      case "imageGenerator":
      case "videoGenerator":
        return {
          ...node,
          outputAssets: [],
          responseText: null,
          lastPrompt: "",
        };
      case "llmGenerator":
        return {
          ...node,
          lastPrompt: "",
          lastSystemPrompt: "",
          responseText: null,
        };
      default:
        return node;
    }
  },

  applyUploadedAssets(
    node: WorkflowDocumentNode,
    assets: WorkflowAsset[],
  ): WorkflowDocumentNode {
    if (!assets.length) {
      return node;
    }

    switch (node.kind) {
      case "asset": {
        const batchKind = getBatchAssetKind(assets);
        assertCompatibleAssetKind(node.assetKind, batchKind);

        return {
          ...node,
          assetKind: node.assetKind ?? batchKind,
          assets: [...node.assets, ...assets],
        };
      }
      default:
        return node;
    }
  },
};
