import { estimateTokenCount } from "tokenx";

import type {
  GeneratorControlDefinition,
  GeneratorHandleDefinition,
} from "~/lib/workflow/generator-models";
import {
  PROMPT_INPUT_HANDLE_ID,
  type WorkflowValueType,
} from "~/lib/workflow/node-definitions";
import type {
  GenerateLlmRequest,
  GenerateLlmUsage,
  GeneratorConfig,
  GeneratorConfigValue,
  LlmGeneratorModelId,
  LlmGeneratorSettings,
  LlmThinkingLevel,
  WorkflowAsset,
} from "~/lib/workflow/types";
import {
  GEMINI_3_FLASH_PREVIEW_MODEL_ID,
  LLM_MODEL_IDS,
  LLM_THINKING_LEVELS,
} from "~/lib/workflow/types";

export const SYSTEM_PROMPT_INPUT_HANDLE_ID = "systemPrompt";

const IMAGE_INPUT_PREFIX = "image-input-";
const GEMINI_3_FLASH_INPUT_USD_PER_MILLION_TOKENS = 0.5;
const GEMINI_3_FLASH_OUTPUT_USD_PER_MILLION_TOKENS = 3;
const DEFAULT_LLM_ESTIMATED_OUTPUT_TOKENS = 2048;

const VALUE_TYPE_COLORS: Record<WorkflowValueType, string> = {
  image: "#38bdf8",
  text: "#f59e0b",
  video: "#818cf8",
};

type LlmGeneratorModelDefinition = {
  id: LlmGeneratorModelId;
  inputUsdPerMillionTokens: number;
  label: string;
  outputUsdPerMillionTokens: number;
  tokenEstimate: {
    defaultCharsPerToken: number;
    imageInputTokens: number;
  };
};

function getConfigNumber(
  config: GeneratorConfig,
  key: string,
  fallback: number,
) {
  const value = config[key];
  return typeof value === "number" ? value : fallback;
}

function getConfigString(
  config: GeneratorConfig,
  key: string,
  fallback: string,
) {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

function flattenAssetsByPrefix(
  imageInputsByHandle: Record<string, WorkflowAsset[]>,
  idPrefix: string,
) {
  return Object.entries(imageInputsByHandle)
    .filter(([handleId]) => handleId.startsWith(idPrefix))
    .sort(([left], [right]) =>
      left.localeCompare(right, undefined, { numeric: true }),
    )
    .flatMap(([, assets]) => assets);
}

function buildHandleDefinitions(
  edges: Array<{ target: string; targetHandle: string | null }>,
  targetId: string,
): GeneratorHandleDefinition[] {
  const connectedImageCount = edges.filter(
    (edge) =>
      edge.target === targetId &&
      Boolean(edge.targetHandle?.startsWith(IMAGE_INPUT_PREFIX)),
  ).length;

  return [
    {
      color: VALUE_TYPE_COLORS.text,
      id: PROMPT_INPUT_HANDLE_ID,
      inputType: "fixed",
      label: "Prompt",
      required: true,
      valueType: "text",
    },
    {
      color: VALUE_TYPE_COLORS.text,
      id: SYSTEM_PROMPT_INPUT_HANDLE_ID,
      inputType: "fixed",
      label: "System",
      required: false,
      valueType: "text",
    },
    ...Array.from({ length: connectedImageCount + 1 }, (_, index) => ({
      color: VALUE_TYPE_COLORS.image,
      id: `${IMAGE_INPUT_PREFIX}${index}`,
      idPrefix: IMAGE_INPUT_PREFIX,
      inputType: "repeatable" as const,
      label: "Image",
      labelIndex: index + 1,
      required: false,
      valueType: "image" as const,
    })),
  ];
}

function createDefaultConfig(): GeneratorConfig {
  return {
    maxOutputTokens: 2048,
    temperature: 1,
    thinkingLevel: "LOW",
  };
}

function normalizeConfig(config: GeneratorConfig) {
  const temperature = getConfigNumber(config, "temperature", 1);
  const maxOutputTokens = getConfigNumber(config, "maxOutputTokens", 2048);
  const thinkingLevel = getConfigString(
    config,
    "thinkingLevel",
    "LOW",
  ) as LlmThinkingLevel;

  return {
    maxOutputTokens: Number.isFinite(maxOutputTokens)
      ? Math.max(1, Math.round(maxOutputTokens))
      : 2048,
    temperature: Number.isFinite(temperature)
      ? Math.min(2, Math.max(0, temperature))
      : 1,
    thinkingLevel: LLM_THINKING_LEVELS.includes(thinkingLevel)
      ? thinkingLevel
      : "LOW",
  } satisfies GeneratorConfig;
}

const LLM_GENERATOR_MODELS: Record<
  LlmGeneratorModelId,
  LlmGeneratorModelDefinition
> = {
  [GEMINI_3_FLASH_PREVIEW_MODEL_ID]: {
    id: GEMINI_3_FLASH_PREVIEW_MODEL_ID,
    inputUsdPerMillionTokens: GEMINI_3_FLASH_INPUT_USD_PER_MILLION_TOKENS,
    label: "Gemini 3 Flash Preview",
    outputUsdPerMillionTokens: GEMINI_3_FLASH_OUTPUT_USD_PER_MILLION_TOKENS,
    tokenEstimate: {
      defaultCharsPerToken: 4,
      imageInputTokens: 1024,
    },
  },
};

function getLlmGeneratorModelDefinition(model: LlmGeneratorModelId) {
  return LLM_GENERATOR_MODELS[model];
}

function estimateTextTokenCount(
  model: LlmGeneratorModelId,
  text: string | null | undefined,
) {
  const value = text?.trim();
  if (!value) {
    return 0;
  }

  return estimateTokenCount(value, {
    defaultCharsPerToken:
      getLlmGeneratorModelDefinition(model).tokenEstimate.defaultCharsPerToken,
  });
}

export function createDefaultLlmGeneratorSettings(
  model: LlmGeneratorModelId = GEMINI_3_FLASH_PREVIEW_MODEL_ID,
): LlmGeneratorSettings {
  return {
    config: createDefaultConfig(),
    mode: null,
    model,
  };
}

export function normalizeLlmGeneratorSettings(
  settings: Partial<LlmGeneratorSettings> | null | undefined,
) {
  const model = LLM_MODEL_IDS.includes(settings?.model as LlmGeneratorModelId)
    ? (settings?.model as LlmGeneratorModelId)
    : GEMINI_3_FLASH_PREVIEW_MODEL_ID;

  return {
    config: normalizeConfig(settings?.config ?? {}),
    mode: null,
    model,
  } satisfies LlmGeneratorSettings;
}

export function getLlmGeneratorModelOptions() {
  return LLM_MODEL_IDS.map((model) => ({
    label: getLlmGeneratorModelDefinition(model).label,
    value: model,
  }));
}

export function getLlmGeneratorControlDefinitions(_model: LlmGeneratorModelId) {
  return [
    {
      key: "temperature",
      label: "Temperature",
      max: 2,
      min: 0,
      step: 0.1,
      type: "range",
    },
    {
      key: "thinkingLevel",
      label: "Thinking",
      options: LLM_THINKING_LEVELS.map((value) => ({ label: value, value })),
      type: "select",
    },
    {
      key: "maxOutputTokens",
      label: "Max tokens",
      max: 8192,
      min: 1,
      step: 1,
      type: "number",
    },
  ] satisfies readonly GeneratorControlDefinition[];
}

export function getLlmGeneratorHandleDefinitions(
  _settings: Pick<LlmGeneratorSettings, "model" | "mode">,
  edges: Array<{ target: string; targetHandle: string | null }>,
  targetId: string,
) {
  return buildHandleDefinitions(edges, targetId);
}

export function buildLlmGenerationRequest(params: {
  settings: LlmGeneratorSettings;
  imageInputsByHandle: Record<string, WorkflowAsset[]>;
  prompt: string;
  systemPrompt: string | null;
}) {
  const config = normalizeConfig(params.settings.config);

  return {
    maxOutputTokens: getConfigNumber(config, "maxOutputTokens", 2048),
    mode: params.settings.mode,
    model: params.settings.model,
    prompt: params.prompt,
    referenceImages: flattenAssetsByPrefix(
      params.imageInputsByHandle,
      IMAGE_INPUT_PREFIX,
    ),
    systemPrompt: params.systemPrompt,
    temperature: getConfigNumber(config, "temperature", 1),
    thinkingLevel: getConfigString(
      config,
      "thinkingLevel",
      "LOW",
    ) as LlmThinkingLevel,
  } satisfies GenerateLlmRequest;
}

export function setLlmGeneratorConfigValue(
  config: GeneratorConfig,
  key: string,
  value: GeneratorConfigValue,
) {
  return normalizeConfig({
    ...config,
    [key]: value,
  });
}

export function estimateLlmRequestInputTokens(request: GenerateLlmRequest) {
  const modelDefinition = getLlmGeneratorModelDefinition(request.model);

  return (
    estimateTextTokenCount(request.model, request.prompt) +
    estimateTextTokenCount(request.model, request.systemPrompt) +
    (request.referenceImages?.length ?? 0) *
      modelDefinition.tokenEstimate.imageInputTokens
  );
}

export function getLlmInputUsdPerMillionTokens(model: LlmGeneratorModelId) {
  return getLlmGeneratorModelDefinition(model).inputUsdPerMillionTokens;
}

export function getLlmOutputUsdPerMillionTokens(model: LlmGeneratorModelId) {
  return getLlmGeneratorModelDefinition(model).outputUsdPerMillionTokens;
}

export function convertUsdToCredits(usd: number) {
  if (usd <= 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(usd * 100));
}

export function calculateLlmUsageUsd(params: {
  model: LlmGeneratorModelId;
  usage: GenerateLlmUsage;
}) {
  const inputUsd =
    (params.usage.promptTokenCount / 1_000_000) *
    getLlmInputUsdPerMillionTokens(params.model);
  const outputUsd =
    ((params.usage.candidatesTokenCount + params.usage.thoughtsTokenCount) /
      1_000_000) *
    getLlmOutputUsdPerMillionTokens(params.model);

  return inputUsd + outputUsd;
}

export function calculateLlmUsageCreditCost(params: {
  model: LlmGeneratorModelId;
  usage: GenerateLlmUsage;
}) {
  return convertUsdToCredits(calculateLlmUsageUsd(params));
}

export function calculateLlmEstimateCreditCost(params: {
  estimatedInputTokens: number;
  maxOutputTokens: number;
  model: LlmGeneratorModelId;
}) {
  const inputUsd =
    (params.estimatedInputTokens / 1_000_000) *
    getLlmInputUsdPerMillionTokens(params.model);
  const outputUsd =
    (params.maxOutputTokens / 1_000_000) *
    getLlmOutputUsdPerMillionTokens(params.model);

  return convertUsdToCredits(inputUsd + outputUsd);
}

export function calculateLlmRequestEstimateCreditCost(
  request: GenerateLlmRequest,
) {
  return calculateLlmEstimateCreditCost({
    estimatedInputTokens: estimateLlmRequestInputTokens(request),
    maxOutputTokens: DEFAULT_LLM_ESTIMATED_OUTPUT_TOKENS,
    model: request.model,
  });
}
