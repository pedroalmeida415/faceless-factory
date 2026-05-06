import type {
  GeneratorControlDefinition,
  GeneratorHandleDefinition,
} from "~/features/workflow/generator-models";
import {
  PROMPT_INPUT_HANDLE_ID,
  type WorkflowValueType,
} from "~/features/workflow/node-definitions";
import type {
  GenerateLlmRequest,
  GeneratorConfig,
  GeneratorConfigValue,
  LlmGeneratorModelId,
  LlmGeneratorSettings,
  LlmThinkingLevel,
  WorkflowAsset,
} from "~/features/workflow/types";
import {
  GEMINI_3_FLASH_PREVIEW_MODEL_ID,
  LLM_MODEL_IDS,
  LLM_THINKING_LEVELS,
} from "~/features/workflow/types";

export const SYSTEM_PROMPT_INPUT_HANDLE_ID = "systemPrompt";

const IMAGE_INPUT_PREFIX = "image-input-";

const VALUE_TYPE_COLORS: Record<WorkflowValueType, string> = {
  image: "#38bdf8",
  text: "#f59e0b",
  video: "#818cf8",
};

type LlmGeneratorModelDefinition = {
  id: LlmGeneratorModelId;
  label: string;
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
    label: "Gemini 3 Flash Preview",
  },
};

function getLlmGeneratorModelDefinition(model: LlmGeneratorModelId) {
  return LLM_GENERATOR_MODELS[model];
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
  idempotencyKey?: string | null;
  imageInputsByHandle: Record<string, WorkflowAsset[]>;
  prompt: string;
  systemPrompt: string | null;
}) {
  const config = normalizeConfig(params.settings.config);

  return {
    idempotencyKey: params.idempotencyKey ?? null,
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
