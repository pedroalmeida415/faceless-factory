import type {
  WorkflowDocument,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import type {
  GenerateImageRequest,
  GenerateLlmResponse,
  GenerateLlmUsage,
  GenerateVideoRequest,
} from "~/lib/workflow/types";
import {
  GEMINI_3_FLASH_PREVIEW_MODEL_ID,
  IMAGE_MODEL_IDS,
  type ImageGeneratorModelId,
  LLM_MODEL_IDS,
  type LlmGeneratorModelId,
  VIDEO_MODEL_IDS,
  type VideoGeneratorModelId,
} from "~/lib/workflow/types";

const IMAGE_GENERATOR_CREDIT_COST_BY_MODEL = {
  [IMAGE_MODEL_IDS[0]]: 10,
} satisfies Record<ImageGeneratorModelId, number>;

const VIDEO_GENERATOR_CREDIT_COST_BY_MODEL = {
  [VIDEO_MODEL_IDS[0]]: 40,
} satisfies Record<VideoGeneratorModelId, number>;

const LLM_ESTIMATED_CREDIT_COST = 1;
const LLM_PRICING_BY_MODEL = {
  [GEMINI_3_FLASH_PREVIEW_MODEL_ID]: {
    inputUsdPerMillionTokens: 0.5,
    outputUsdPerMillionTokens: 3,
  },
} satisfies Record<
  LlmGeneratorModelId,
  {
    readonly inputUsdPerMillionTokens: number;
    readonly outputUsdPerMillionTokens: number;
  }
>;

function getImageGeneratorModelCreditCost(model: ImageGeneratorModelId) {
  return IMAGE_GENERATOR_CREDIT_COST_BY_MODEL[model];
}

function getVideoGeneratorModelCreditCost(model: VideoGeneratorModelId) {
  return VIDEO_GENERATOR_CREDIT_COST_BY_MODEL[model];
}

function convertUsdToCredits(usd: number) {
  return usd <= 0 ? 0 : Math.max(1, Math.ceil(usd * 100));
}

function calculateLlmUsageCreditCost(params: {
  readonly model: LlmGeneratorModelId;
  readonly usage: GenerateLlmUsage;
}) {
  const pricing = LLM_PRICING_BY_MODEL[params.model];
  const inputUsd =
    (params.usage.promptTokenCount / 1_000_000) *
    pricing.inputUsdPerMillionTokens;
  const outputUsd =
    ((params.usage.candidatesTokenCount + params.usage.thoughtsTokenCount) /
      1_000_000) *
    pricing.outputUsdPerMillionTokens;

  return convertUsdToCredits(inputUsd + outputUsd);
}

export type PricingCatalogNodeKind =
  | "imageGenerator"
  | "videoGenerator"
  | "llmGenerator";

export type ExecutionCostProjectionLineItem = {
  readonly nodeId: string;
  readonly kind: PricingCatalogNodeKind;
  readonly creditCostPerSlot: number;
  readonly isEstimate: boolean;
};

export type ExecutionCostProjection = {
  readonly costsByNodeId: Readonly<
    Record<string, ExecutionCostProjectionLineItem>
  >;
  readonly lineItems: readonly ExecutionCostProjectionLineItem[];
};

export type WorkflowRuntimeEstimatedCreditCostByNodeId = Readonly<
  Record<string, number>
>;

function unsupportedPricing(node: WorkflowDocumentNode): never {
  const model = "model" in node ? String(node.model) : "unknown";
  throw new WorkflowValidationError({
    message: `Unsupported Pricing Catalog entry for ${node.kind} model ${model}.`,
  });
}

function isPricingCatalogNodeKind(
  kind: WorkflowDocumentNode["kind"],
): kind is PricingCatalogNodeKind {
  return (
    kind === "imageGenerator" ||
    kind === "videoGenerator" ||
    kind === "llmGenerator"
  );
}

function getCatalogCreditCost(node: WorkflowDocumentNode) {
  switch (node.kind) {
    case "imageGenerator":
      if (!IMAGE_MODEL_IDS.includes(node.model as ImageGeneratorModelId)) {
        return unsupportedPricing(node);
      }
      return {
        creditCostPerSlot: getImageGeneratorModelCreditCost(node.model),
        isEstimate: false,
      };
    case "videoGenerator":
      if (!VIDEO_MODEL_IDS.includes(node.model as VideoGeneratorModelId)) {
        return unsupportedPricing(node);
      }
      return {
        creditCostPerSlot: getVideoGeneratorModelCreditCost(node.model),
        isEstimate: false,
      };
    case "llmGenerator":
      if (!LLM_MODEL_IDS.includes(node.model as LlmGeneratorModelId)) {
        return unsupportedPricing(node);
      }
      return {
        creditCostPerSlot: LLM_ESTIMATED_CREDIT_COST,
        isEstimate: true,
      };
    default:
      return null;
  }
}

export function buildExecutionCostProjection(
  document: WorkflowDocument,
): ExecutionCostProjection {
  const lineItems = document.nodes.flatMap((node) => {
    const price = getCatalogCreditCost(node);
    return price && isPricingCatalogNodeKind(node.kind)
      ? [
          {
            nodeId: node.id,
            kind: node.kind,
            ...price,
          },
        ]
      : [];
  });

  return {
    costsByNodeId: Object.fromEntries(
      lineItems.map((lineItem) => [lineItem.nodeId, lineItem]),
    ),
    lineItems,
  };
}

export function priceImageGeneration(request: GenerateImageRequest) {
  return getImageGeneratorModelCreditCost(request.model);
}

export function priceLlmGeneration(
  response: Pick<GenerateLlmResponse, "model" | "usage">,
) {
  return calculateLlmUsageCreditCost(response);
}

export function priceVideoGeneration(request: GenerateVideoRequest) {
  return getVideoGeneratorModelCreditCost(request.model);
}

export function estimateWorkflowRuntimeCreditCostByNodeId(input: {
  readonly document: WorkflowDocument;
}): WorkflowRuntimeEstimatedCreditCostByNodeId {
  return Object.fromEntries(
    buildExecutionCostProjection(input.document).lineItems.map((lineItem) => [
      lineItem.nodeId,
      lineItem.creditCostPerSlot,
    ]),
  );
}
