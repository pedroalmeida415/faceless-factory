import type {
  ImageGeneratorWorkflowNode,
  ListWorkflowNode,
  LlmGeneratorWorkflowNode,
  OutputReorderWorkflowNode,
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
import type { WorkflowValueType } from "~/lib/workflow/node-definitions";
import type {
  GeneratorConfigValue,
  ImageGeneratorModelId,
  MediaAssetKind,
  PromptDisplayMode,
  PromptVariable,
  VideoGeneratorModelId,
  WorkflowAsset,
} from "~/lib/workflow/types";

function getBatchAssetKind(assets: WorkflowAsset[]) {
  const firstAsset = assets[0];
  if (!firstAsset) {
    return null;
  }

  if (firstAsset.kind !== "image" && firstAsset.kind !== "video") {
    throw new WorkflowValidationError({
      message: "Asset nodes only accept image or video assets.",
    });
  }

  if (!assets.every((asset) => asset.kind === firstAsset.kind)) {
    throw new WorkflowValidationError({
      message: "Asset nodes only accept one media type at a time.",
    });
  }

  return firstAsset.kind;
}

function assertCompatibleAssetKind(
  expectedKind: MediaAssetKind | null,
  nextKind: MediaAssetKind | null,
) {
  if (!expectedKind || !nextKind || expectedKind === nextKind) {
    return;
  }

  throw new WorkflowValidationError({
    message: `This asset node is locked to ${expectedKind}s. Clear it before switching media type.`,
  });
}

function createPromptVariable(node: PromptWorkflowNode) {
  let nextIndex = node.variables.length + 1;
  let key = `variable${nextIndex}`;

  while (node.variables.some((variable) => variable.key === key)) {
    nextIndex += 1;
    key = `variable${nextIndex}`;
  }

  return {
    key,
    label: `Variable ${nextIndex}`,
  } satisfies PromptVariable;
}

export const PromptNodeService = {
  setPrompt(node: PromptWorkflowNode, prompt: string): PromptWorkflowNode {
    return {
      ...node,
      prompt,
    };
  },

  setDisplayMode(
    node: PromptWorkflowNode,
    displayMode: PromptDisplayMode,
  ): PromptWorkflowNode {
    return {
      ...node,
      displayMode,
    };
  },

  addVariable(node: PromptWorkflowNode): {
    node: PromptWorkflowNode;
    variable: PromptVariable;
  } {
    const variable = createPromptVariable(node);

    return {
      node: {
        ...node,
        variables: [...node.variables, variable],
      },
      variable,
    };
  },

  seedTextVariable(node: PromptWorkflowNode): {
    node: PromptWorkflowNode;
    variable: PromptVariable;
  } {
    const result = PromptNodeService.addVariable(node);

    return {
      node: {
        ...result.node,
        prompt: `{{${result.variable.key}}}`,
      },
      variable: result.variable,
    };
  },
};

export const ListNodeService = {
  setItems(node: ListWorkflowNode, items: string[]): ListWorkflowNode {
    return {
      ...node,
      items,
    };
  },
};

export const OutputReorderNodeService = {
  setMode(
    node: OutputReorderWorkflowNode,
    mode: OutputReorderWorkflowNode["mode"],
  ): OutputReorderWorkflowNode {
    return {
      ...node,
      mode,
    };
  },

  setOrder(
    node: OutputReorderWorkflowNode,
    order: number[],
  ): OutputReorderWorkflowNode {
    return {
      ...node,
      mode: "manual",
      order,
    };
  },

  setShift(
    node: OutputReorderWorkflowNode,
    shift: number,
  ): OutputReorderWorkflowNode {
    return {
      ...node,
      mode: "shift",
      shift: Math.trunc(shift),
    };
  },

  setValueType(
    node: OutputReorderWorkflowNode,
    valueType: WorkflowValueType | null,
  ): OutputReorderWorkflowNode {
    return {
      ...node,
      valueType,
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
      outputs: WorkflowAsset[][];
    },
  ): ImageGeneratorWorkflowNode {
    return {
      ...node,
      lastPrompt: result.lastPrompt,
      outputs: result.outputs,
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
      outputs: WorkflowAsset[][];
    },
  ): VideoGeneratorWorkflowNode {
    return {
      ...node,
      lastPrompt: result.lastPrompt,
      outputs: result.outputs,
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
      outputs: string[];
    },
  ): LlmGeneratorWorkflowNode {
    return {
      ...node,
      lastPrompt: result.lastPrompt,
      lastSystemPrompt: result.lastSystemPrompt,
      outputs: result.outputs,
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
