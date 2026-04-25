import {
  type HandleDefinition,
  PROMPT_INPUT_HANDLE_ID,
  type WorkflowValueType,
} from "~/lib/workflow/node-definitions";
import {
  type GenerateImageRequest,
  type GenerateVideoRequest,
  type GeneratorConfig,
  type GeneratorConfigValue,
  IMAGE_ASPECT_RATIOS,
  IMAGE_MODEL_IDS,
  type ImageAspectRatio,
  type ImageGeneratorModelId,
  type ImageGeneratorSettings,
  NANO_BANANA_PRO_MODEL_ID,
  VEO_31_FAST_MODEL_ID,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_MODEL_IDS,
  VIDEO_RESOLUTIONS,
  type VideoAspectRatio,
  type VideoDuration,
  type VideoGeneratorModelId,
  type VideoGeneratorSettings,
  type WorkflowAsset,
} from "~/lib/workflow/types";

const VALUE_TYPE_COLORS: Record<WorkflowValueType, string> = {
  image: "#38bdf8",
  text: "#f59e0b",
  video: "#818cf8",
};

type GeneratorControlOption = {
  label: string;
  value: string;
};

type SelectGeneratorControlDefinition = {
  type: "select";
  key: string;
  label: string;
  options: readonly GeneratorControlOption[];
};

type SwitchGeneratorControlDefinition = {
  type: "switch";
  key: string;
  label: string;
};

type RangeGeneratorControlDefinition = {
  type: "range";
  key: string;
  label: string;
  min: number;
  max: number;
  step?: number;
};

type NumberGeneratorControlDefinition = {
  type: "number";
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
};

export type GeneratorControlDefinition =
  | SelectGeneratorControlDefinition
  | SwitchGeneratorControlDefinition
  | RangeGeneratorControlDefinition
  | NumberGeneratorControlDefinition;

type FixedGeneratorInputDefinition = {
  type: "fixed";
  id: string;
  label: string;
  valueType: WorkflowValueType;
  required: boolean;
};

type RepeatableGeneratorInputDefinition = {
  type: "repeatable";
  idPrefix: string;
  label: string;
  valueType: WorkflowValueType;
  required: boolean;
  maxConnections: number | null;
};

type GeneratorInputDefinition =
  | FixedGeneratorInputDefinition
  | RepeatableGeneratorInputDefinition;

type BaseGeneratorHandleDefinition = HandleDefinition & {
  valueType: WorkflowValueType;
  required: boolean;
};

export type GeneratorHandleDefinition = BaseGeneratorHandleDefinition &
  ({ inputType: "fixed" } | { inputType: "repeatable"; idPrefix: string });

type ImageGeneratorModeDefinition = {
  id: string;
  label: string;
  inputs: readonly GeneratorInputDefinition[];
  controls: readonly GeneratorControlDefinition[];
  buildRequest: (params: {
    config: GeneratorConfig;
    imageInputsByHandle: Record<string, WorkflowAsset[]>;
    mode: string | null;
    model: ImageGeneratorModelId;
  }) => GenerateImageRequest;
};

type VideoGeneratorModeDefinition = {
  id: string;
  label: string;
  inputs: readonly GeneratorInputDefinition[];
  controls: readonly GeneratorControlDefinition[];
  buildRequest: (params: {
    config: GeneratorConfig;
    imageInputsByHandle: Record<string, WorkflowAsset[]>;
    mode: string | null;
    model: VideoGeneratorModelId;
  }) => GenerateVideoRequest;
};

type ImageGeneratorModelDefinition = {
  id: ImageGeneratorModelId;
  label: string;
  creditCost: number;
  defaultMode: string;
  modes: readonly ImageGeneratorModeDefinition[];
};

type VideoGeneratorModelDefinition = {
  id: VideoGeneratorModelId;
  label: string;
  creditCost: number;
  defaultMode: string;
  modes: readonly VideoGeneratorModeDefinition[];
};

const IMAGE_REFERENCE_INPUT_PREFIX = "image-input-";
const VIDEO_FIRST_FRAME_INPUT_ID = "first-frame";
const VIDEO_LAST_FRAME_INPUT_ID = "last-frame";

function getFirstAssetByHandle(
  imageInputsByHandle: Record<string, WorkflowAsset[]>,
  handleId: string,
) {
  return imageInputsByHandle[handleId]?.[0];
}

function createSelectOptions(values: readonly (string | number)[]) {
  return values.map((value) => ({
    label: String(value),
    value: String(value),
  }));
}

function getConfigString(
  config: GeneratorConfig,
  key: string,
  fallback: string,
) {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

function getConfigBoolean(
  config: GeneratorConfig,
  key: string,
  fallback: boolean,
) {
  const value = config[key];
  return typeof value === "boolean" ? value : fallback;
}

function getConfigNumber(
  config: GeneratorConfig,
  key: string,
  fallback: number,
) {
  const value = config[key];
  return typeof value === "number" ? value : fallback;
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

const IMAGE_GENERATOR_MODELS: Record<
  ImageGeneratorModelId,
  ImageGeneratorModelDefinition
> = {
  [NANO_BANANA_PRO_MODEL_ID]: {
    id: NANO_BANANA_PRO_MODEL_ID,
    label: "Gemini 3 Pro Image (Nano Banana)",
    creditCost: 10,
    defaultMode: "default",
    modes: [
      {
        id: "default",
        label: "Default",
        inputs: [
          {
            type: "fixed",
            id: PROMPT_INPUT_HANDLE_ID,
            label: "Prompt",
            required: true,
            valueType: "text",
          },
          {
            type: "repeatable",
            idPrefix: IMAGE_REFERENCE_INPUT_PREFIX,
            label: "Image",
            maxConnections: null,
            required: false,
            valueType: "image",
          },
        ],
        controls: [
          {
            type: "select",
            key: "aspectRatio",
            label: "Aspect",
            options: createSelectOptions(IMAGE_ASPECT_RATIOS),
          },
        ],
        buildRequest: ({ config, imageInputsByHandle, mode, model }) => ({
          model,
          mode,
          prompt: "",
          referenceImages: flattenAssetsByPrefix(
            imageInputsByHandle,
            IMAGE_REFERENCE_INPUT_PREFIX,
          ),
          aspectRatio: getConfigString(
            config,
            "aspectRatio",
            "1:1",
          ) as ImageAspectRatio,
        }),
      },
    ],
  },
};

const VIDEO_GENERATOR_MODELS: Record<
  VideoGeneratorModelId,
  VideoGeneratorModelDefinition
> = {
  [VEO_31_FAST_MODEL_ID]: {
    id: VEO_31_FAST_MODEL_ID,
    label: "Veo 3.1 Fast",
    creditCost: 40,
    defaultMode: "ingredients",
    modes: [
      {
        id: "ingredients",
        label: "Ingredients",
        inputs: [
          {
            type: "fixed",
            id: PROMPT_INPUT_HANDLE_ID,
            label: "Prompt",
            required: true,
            valueType: "text",
          },
          {
            type: "repeatable",
            idPrefix: IMAGE_REFERENCE_INPUT_PREFIX,
            label: "Image",
            maxConnections: null,
            required: false,
            valueType: "image",
          },
        ],
        controls: [
          {
            type: "select",
            key: "aspectRatio",
            label: "Aspect",
            options: createSelectOptions(VIDEO_ASPECT_RATIOS),
          },
          {
            type: "select",
            key: "durationSeconds",
            label: "Duration",
            options: VIDEO_DURATIONS.map((duration) => ({
              label: `${duration}s`,
              value: String(duration),
            })),
          },
          {
            type: "select",
            key: "resolution",
            label: "Resolution",
            options: createSelectOptions(VIDEO_RESOLUTIONS),
          },
          {
            type: "switch",
            key: "generateAudio",
            label: "Generate audio",
          },
        ],
        buildRequest: ({ config, imageInputsByHandle, mode, model }) => ({
          model,
          mode,
          prompt: "",
          referenceImages: flattenAssetsByPrefix(
            imageInputsByHandle,
            IMAGE_REFERENCE_INPUT_PREFIX,
          ),
          aspectRatio: getConfigString(
            config,
            "aspectRatio",
            "16:9",
          ) as VideoAspectRatio,
          durationSeconds: getConfigNumber(
            config,
            "durationSeconds",
            4,
          ) as VideoDuration,
          generateAudio: getConfigBoolean(config, "generateAudio", true),
          resolution: getConfigString(
            config,
            "resolution",
            "720p",
          ) as (typeof VIDEO_RESOLUTIONS)[number],
        }),
      },
      {
        id: "first-last-frame",
        label: "First & Last Frame",
        inputs: [
          {
            type: "fixed",
            id: PROMPT_INPUT_HANDLE_ID,
            label: "Prompt",
            required: false,
            valueType: "text",
          },
          {
            type: "fixed",
            id: VIDEO_FIRST_FRAME_INPUT_ID,
            label: "First frame",
            required: true,
            valueType: "image",
          },
          {
            type: "fixed",
            id: VIDEO_LAST_FRAME_INPUT_ID,
            label: "Last frame",
            required: true,
            valueType: "image",
          },
        ],
        controls: [
          {
            type: "select",
            key: "aspectRatio",
            label: "Aspect",
            options: createSelectOptions(VIDEO_ASPECT_RATIOS),
          },
          {
            type: "select",
            key: "durationSeconds",
            label: "Duration",
            options: VIDEO_DURATIONS.map((duration) => ({
              label: `${duration}s`,
              value: String(duration),
            })),
          },
          {
            type: "select",
            key: "resolution",
            label: "Resolution",
            options: createSelectOptions(VIDEO_RESOLUTIONS),
          },
          {
            type: "switch",
            key: "generateAudio",
            label: "Generate audio",
          },
        ],
        buildRequest: ({ config, imageInputsByHandle, mode, model }) => ({
          model,
          mode,
          prompt: "",
          firstFrame: getFirstAssetByHandle(
            imageInputsByHandle,
            VIDEO_FIRST_FRAME_INPUT_ID,
          ),
          lastFrame: getFirstAssetByHandle(
            imageInputsByHandle,
            VIDEO_LAST_FRAME_INPUT_ID,
          ),
          aspectRatio: getConfigString(
            config,
            "aspectRatio",
            "16:9",
          ) as VideoAspectRatio,
          durationSeconds: getConfigNumber(
            config,
            "durationSeconds",
            4,
          ) as VideoDuration,
          generateAudio: getConfigBoolean(config, "generateAudio", true),
          resolution: getConfigString(
            config,
            "resolution",
            "720p",
          ) as (typeof VIDEO_RESOLUTIONS)[number],
        }),
      },
    ],
  },
};

function getImageGeneratorModelDefinition(model: ImageGeneratorModelId) {
  return IMAGE_GENERATOR_MODELS[model];
}

function getVideoGeneratorModelDefinition(model: VideoGeneratorModelId) {
  return VIDEO_GENERATOR_MODELS[model];
}

function getImageGeneratorModeDefinition(
  model: ImageGeneratorModelId,
  mode: string | null,
) {
  const definition = getImageGeneratorModelDefinition(model);
  return (definition.modes.find((candidate) => candidate.id === mode) ??
    definition.modes[0]) as ImageGeneratorModeDefinition;
}

function getVideoGeneratorModeDefinition(
  model: VideoGeneratorModelId,
  mode: string | null,
) {
  const definition = getVideoGeneratorModelDefinition(model);
  return (definition.modes.find((candidate) => candidate.id === mode) ??
    definition.modes[0]) as VideoGeneratorModeDefinition;
}

function toHandleDefinition(
  input: GeneratorInputDefinition,
  id: string,
  labelIndex?: number,
): GeneratorHandleDefinition {
  const baseDefinition = {
    color: VALUE_TYPE_COLORS[input.valueType],
    id,
    label: input.label,
    labelIndex,
    required: input.required,
    valueType: input.valueType,
  } satisfies BaseGeneratorHandleDefinition;

  if (input.type === "fixed") {
    return {
      ...baseDefinition,
      inputType: "fixed",
    };
  }

  return {
    ...baseDefinition,
    inputType: "repeatable",
    idPrefix: input.idPrefix,
  };
}

function isRepeatableHandleId(
  handleId: string | null | undefined,
  idPrefix: string,
) {
  return Boolean(handleId?.startsWith(idPrefix));
}

function buildHandleDefinitions(
  inputs: readonly GeneratorInputDefinition[],
  edges: Array<{ target: string; targetHandle: string | null }>,
  targetId: string,
) {
  return inputs.flatMap((input) => {
    if (input.type === "fixed") {
      return [toHandleDefinition(input, input.id)];
    }

    const connectedCount = edges.filter(
      (edge) =>
        edge.target === targetId &&
        isRepeatableHandleId(edge.targetHandle, input.idPrefix),
    ).length;
    const visibleCount = Math.min(
      input.maxConnections ?? connectedCount + 1,
      connectedCount + 1,
    );

    return Array.from({ length: visibleCount }, (_, index) =>
      toHandleDefinition(input, `${input.idPrefix}${index}`, index + 1),
    );
  });
}

function createImageGeneratorDefaultConfig(
  model: ImageGeneratorModelId,
): GeneratorConfig {
  switch (model) {
    case NANO_BANANA_PRO_MODEL_ID:
      return { aspectRatio: "1:1" };
  }
}

function createVideoGeneratorDefaultConfig(
  model: VideoGeneratorModelId,
): GeneratorConfig {
  switch (model) {
    case VEO_31_FAST_MODEL_ID:
      return {
        aspectRatio: "16:9",
        durationSeconds: 4,
        generateAudio: true,
        resolution: "720p",
      };
  }
}

function normalizeImageGeneratorConfig(
  model: ImageGeneratorModelId,
  config: GeneratorConfig,
) {
  switch (model) {
    case NANO_BANANA_PRO_MODEL_ID:
      return {
        aspectRatio: IMAGE_ASPECT_RATIOS.includes(
          config.aspectRatio as ImageAspectRatio,
        )
          ? (config.aspectRatio as ImageAspectRatio)
          : "1:1",
      } satisfies GeneratorConfig;
  }
}

function normalizeVideoGeneratorConfig(
  model: VideoGeneratorModelId,
  config: GeneratorConfig,
) {
  switch (model) {
    case VEO_31_FAST_MODEL_ID:
      return {
        aspectRatio: VIDEO_ASPECT_RATIOS.includes(
          config.aspectRatio as VideoAspectRatio,
        )
          ? (config.aspectRatio as VideoAspectRatio)
          : "16:9",
        durationSeconds: VIDEO_DURATIONS.includes(
          config.durationSeconds as VideoDuration,
        )
          ? (config.durationSeconds as VideoDuration)
          : 4,
        generateAudio:
          typeof config.generateAudio === "boolean"
            ? config.generateAudio
            : true,
        resolution: VIDEO_RESOLUTIONS.includes(
          config.resolution as (typeof VIDEO_RESOLUTIONS)[number],
        )
          ? (config.resolution as (typeof VIDEO_RESOLUTIONS)[number])
          : "720p",
      } satisfies GeneratorConfig;
  }
}

export function getImageGeneratorModelOptions() {
  return IMAGE_MODEL_IDS.map((model) => ({
    creditCost: getImageGeneratorModelDefinition(model).creditCost,
    label: getImageGeneratorModelDefinition(model).label,
    value: model,
  }));
}

export function getVideoGeneratorModelOptions() {
  return VIDEO_MODEL_IDS.map((model) => ({
    creditCost: getVideoGeneratorModelDefinition(model).creditCost,
    label: getVideoGeneratorModelDefinition(model).label,
    value: model,
  }));
}

export function getImageGeneratorModelCreditCost(model: ImageGeneratorModelId) {
  return getImageGeneratorModelDefinition(model).creditCost;
}

export function getVideoGeneratorModelCreditCost(model: VideoGeneratorModelId) {
  return getVideoGeneratorModelDefinition(model).creditCost;
}

export function getImageGeneratorModeOptions(model: ImageGeneratorModelId) {
  return getImageGeneratorModelDefinition(model).modes.map((mode) => ({
    label: mode.label,
    value: mode.id,
  }));
}

export function getVideoGeneratorModeOptions(model: VideoGeneratorModelId) {
  return getVideoGeneratorModelDefinition(model).modes.map((mode) => ({
    label: mode.label,
    value: mode.id,
  }));
}

export function getImageGeneratorControlDefinitions(
  model: ImageGeneratorModelId,
  mode: string | null,
) {
  return getImageGeneratorModeDefinition(model, mode).controls;
}

export function getVideoGeneratorControlDefinitions(
  model: VideoGeneratorModelId,
  mode: string | null,
) {
  return getVideoGeneratorModeDefinition(model, mode).controls;
}

export function getImageGeneratorHandleDefinitions(
  settings: Pick<ImageGeneratorSettings, "model" | "mode">,
  edges: Array<{ target: string; targetHandle: string | null }>,
  targetId: string,
) {
  return buildHandleDefinitions(
    getImageGeneratorModeDefinition(settings.model, settings.mode).inputs,
    edges,
    targetId,
  );
}

export function getVideoGeneratorHandleDefinitions(
  settings: Pick<VideoGeneratorSettings, "model" | "mode">,
  edges: Array<{ target: string; targetHandle: string | null }>,
  targetId: string,
) {
  return buildHandleDefinitions(
    getVideoGeneratorModeDefinition(settings.model, settings.mode).inputs,
    edges,
    targetId,
  );
}

export function createDefaultImageGeneratorSettings(
  model: ImageGeneratorModelId = NANO_BANANA_PRO_MODEL_ID,
): ImageGeneratorSettings {
  const definition = getImageGeneratorModelDefinition(model);

  return {
    model,
    mode: definition.defaultMode,
    config: createImageGeneratorDefaultConfig(model),
  };
}

export function createDefaultVideoGeneratorSettings(
  model: VideoGeneratorModelId = VEO_31_FAST_MODEL_ID,
): VideoGeneratorSettings {
  const definition = getVideoGeneratorModelDefinition(model);

  return {
    model,
    mode: definition.defaultMode,
    config: createVideoGeneratorDefaultConfig(model),
  };
}

export function normalizeImageGeneratorSettings(
  settings: Partial<ImageGeneratorSettings> | null | undefined,
) {
  const model = IMAGE_MODEL_IDS.includes(
    settings?.model as ImageGeneratorModelId,
  )
    ? (settings?.model as ImageGeneratorModelId)
    : NANO_BANANA_PRO_MODEL_ID;
  const definition = getImageGeneratorModelDefinition(model);
  const mode = definition.modes.some(
    (candidate) => candidate.id === settings?.mode,
  )
    ? (settings?.mode ?? definition.defaultMode)
    : definition.defaultMode;

  return {
    model,
    mode,
    config: normalizeImageGeneratorConfig(model, settings?.config ?? {}),
  } satisfies ImageGeneratorSettings;
}

export function normalizeVideoGeneratorSettings(
  settings: Partial<VideoGeneratorSettings> | null | undefined,
) {
  const model = VIDEO_MODEL_IDS.includes(
    settings?.model as VideoGeneratorModelId,
  )
    ? (settings?.model as VideoGeneratorModelId)
    : VEO_31_FAST_MODEL_ID;
  const definition = getVideoGeneratorModelDefinition(model);
  const mode = definition.modes.some(
    (candidate) => candidate.id === settings?.mode,
  )
    ? (settings?.mode ?? definition.defaultMode)
    : definition.defaultMode;

  return {
    model,
    mode,
    config: normalizeVideoGeneratorConfig(model, settings?.config ?? {}),
  } satisfies VideoGeneratorSettings;
}

export function setImageGeneratorModel(
  model: ImageGeneratorModelId,
): ImageGeneratorSettings {
  return createDefaultImageGeneratorSettings(model);
}

export function setVideoGeneratorModel(
  model: VideoGeneratorModelId,
): VideoGeneratorSettings {
  return createDefaultVideoGeneratorSettings(model);
}

export function setImageGeneratorMode(
  settings: ImageGeneratorSettings,
  mode: string,
): ImageGeneratorSettings {
  const definition = getImageGeneratorModelDefinition(settings.model);

  return {
    ...settings,
    mode: definition.modes.some((candidate) => candidate.id === mode)
      ? mode
      : definition.defaultMode,
  };
}

export function setVideoGeneratorMode(
  settings: VideoGeneratorSettings,
  mode: string,
): VideoGeneratorSettings {
  const definition = getVideoGeneratorModelDefinition(settings.model);

  return {
    ...settings,
    mode: definition.modes.some((candidate) => candidate.id === mode)
      ? mode
      : definition.defaultMode,
  };
}

export function setGeneratorConfigValue(
  config: GeneratorConfig,
  key: string,
  value: GeneratorConfigValue,
) {
  return {
    ...config,
    [key]: value,
  } satisfies GeneratorConfig;
}

export function buildImageGenerationRequest(params: {
  settings: ImageGeneratorSettings;
  imageInputsByHandle: Record<string, WorkflowAsset[]>;
  prompt: string;
}) {
  const request = getImageGeneratorModeDefinition(
    params.settings.model,
    params.settings.mode,
  ).buildRequest({
    config: params.settings.config,
    imageInputsByHandle: params.imageInputsByHandle,
    mode: params.settings.mode,
    model: params.settings.model,
  });

  return {
    ...request,
    prompt: params.prompt,
  } satisfies GenerateImageRequest;
}

export function buildVideoGenerationRequest(params: {
  settings: VideoGeneratorSettings;
  imageInputsByHandle: Record<string, WorkflowAsset[]>;
  prompt: string;
}) {
  const request = getVideoGeneratorModeDefinition(
    params.settings.model,
    params.settings.mode,
  ).buildRequest({
    config: params.settings.config,
    imageInputsByHandle: params.imageInputsByHandle,
    mode: params.settings.mode,
    model: params.settings.model,
  });

  return {
    ...request,
    prompt: params.prompt,
  } satisfies GenerateVideoRequest;
}
