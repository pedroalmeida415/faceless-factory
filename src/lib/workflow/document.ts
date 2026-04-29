import {
  createDefaultImageGeneratorSettings,
  createDefaultVideoGeneratorSettings,
  normalizeImageGeneratorSettings,
  normalizeVideoGeneratorSettings,
} from "~/lib/workflow/generator-models";
import {
  createDefaultLlmGeneratorSettings,
  normalizeLlmGeneratorSettings,
} from "~/lib/workflow/llm-models";
import {
  DEFAULT_PROMPT_DISPLAY_MODE,
  formatNodeTitle,
  type WorkflowValueType,
} from "~/lib/workflow/node-definitions";
import type {
  AssetNodeFields,
  GeneratorReviewFields,
  ImageGeneratorSettings,
  ListNodeFields,
  LlmGeneratorSettings,
  OutputReorderNodeFields,
  PromptDisplayMode,
  PromptNodeFields,
  PromptVariable,
  VideoGeneratorSettings,
  WorkflowAsset,
  WorkflowGeneratorResult,
  WorkflowLlmResult,
  WorkflowNodeKind,
  WorkflowReviewOutput,
  WorkflowReviewState,
} from "~/lib/workflow/types";

export const WORKFLOW_DOCUMENT_VERSION = 9;
export const WORKFLOW_GRID_STEP = 5;

export type WorkflowPosition = {
  x: number;
  y: number;
};

type WorkflowDocumentNodeBase = {
  id: string;
  kind: WorkflowNodeKind;
  label: string;
  position: WorkflowPosition;
};

export type PromptWorkflowNode = WorkflowDocumentNodeBase &
  PromptNodeFields & {
    kind: "prompt";
  };

export type AssetWorkflowNode = WorkflowDocumentNodeBase &
  AssetNodeFields & {
    kind: "asset";
  };

export type ListWorkflowNode = WorkflowDocumentNodeBase &
  ListNodeFields & {
    kind: "list";
  };

export type OutputReorderWorkflowNode = WorkflowDocumentNodeBase &
  OutputReorderNodeFields & {
    kind: "outputReorder";
  };

export type ImageGeneratorWorkflowNode = WorkflowDocumentNodeBase &
  ImageGeneratorSettings &
  GeneratorReviewFields &
  WorkflowGeneratorResult & {
    kind: "imageGenerator";
  };

export type VideoGeneratorWorkflowNode = WorkflowDocumentNodeBase &
  VideoGeneratorSettings &
  GeneratorReviewFields &
  WorkflowGeneratorResult & {
    kind: "videoGenerator";
  };

export type LlmGeneratorWorkflowNode = WorkflowDocumentNodeBase &
  LlmGeneratorSettings &
  GeneratorReviewFields &
  WorkflowLlmResult & {
    kind: "llmGenerator";
  };

export type ImageGeneratorWorkflowDefinitionNode = WorkflowDocumentNodeBase &
  ImageGeneratorSettings &
  Pick<GeneratorReviewFields, "reviewEnabled"> & {
    kind: "imageGenerator";
  };

export type VideoGeneratorWorkflowDefinitionNode = WorkflowDocumentNodeBase &
  VideoGeneratorSettings &
  Pick<GeneratorReviewFields, "reviewEnabled"> & {
    kind: "videoGenerator";
  };

export type LlmGeneratorWorkflowDefinitionNode = WorkflowDocumentNodeBase &
  LlmGeneratorSettings &
  Pick<GeneratorReviewFields, "reviewEnabled"> & {
    kind: "llmGenerator";
  };

export type WorkflowDocumentNode =
  | PromptWorkflowNode
  | ListWorkflowNode
  | AssetWorkflowNode
  | OutputReorderWorkflowNode
  | ImageGeneratorWorkflowNode
  | VideoGeneratorWorkflowNode
  | LlmGeneratorWorkflowNode;

export type WorkflowDefinitionDocumentNode =
  | Exclude<
      WorkflowDocumentNode,
      | ImageGeneratorWorkflowNode
      | VideoGeneratorWorkflowNode
      | LlmGeneratorWorkflowNode
    >
  | ImageGeneratorWorkflowDefinitionNode
  | VideoGeneratorWorkflowDefinitionNode
  | LlmGeneratorWorkflowDefinitionNode;

type WorkflowGraphDocumentNode = WorkflowDocumentNode;

export type WorkflowDocumentEdge = {
  id: string;
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
};

export type WorkflowDocument = {
  version: typeof WORKFLOW_DOCUMENT_VERSION;
  nodes: WorkflowDocumentNode[];
  edges: WorkflowDocumentEdge[];
};

export type WorkflowGraphDocument = {
  version: typeof WORKFLOW_DOCUMENT_VERSION;
  nodes: WorkflowGraphDocumentNode[];
  edges: WorkflowDocumentEdge[];
};

export type WorkflowDefinitionGraphDocument = {
  version: typeof WORKFLOW_DOCUMENT_VERSION;
  nodes: WorkflowDefinitionDocumentNode[];
  edges: WorkflowDocumentEdge[];
};

export function createEmptyWorkflowDocument(): WorkflowDocument {
  return {
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes: [],
    edges: [],
  };
}

function nextNodePosition(index: number): WorkflowPosition {
  const column = index % 3;
  const row = Math.floor(index / 3);

  return snapWorkflowPositionToGrid({
    x: 80 + column * 360,
    y: 80 + row * 290,
  });
}

export function snapWorkflowPositionToGrid(
  position: WorkflowPosition,
): WorkflowPosition {
  return {
    x: Math.round(position.x / WORKFLOW_GRID_STEP) * WORKFLOW_GRID_STEP,
    y: Math.round(position.y / WORKFLOW_GRID_STEP) * WORKFLOW_GRID_STEP,
  };
}

function createWorkflowGeneratorResult(): WorkflowGeneratorResult {
  return {
    lastPrompt: "",
    outputs: [],
  };
}

function createWorkflowLlmResult(): WorkflowLlmResult {
  return {
    lastPrompt: "",
    lastSystemPrompt: "",
    outputs: [],
  };
}

function createWorkflowReviewState(): WorkflowReviewState {
  return {
    outputs: [],
    sourceNodeId: null,
    updatedAt: null,
    valueType: null,
  };
}

function createGeneratorReviewFields(): GeneratorReviewFields {
  return {
    review: createWorkflowReviewState(),
    reviewEnabled: false,
  };
}

function makeWorkflowNode(
  id: string,
  kind: WorkflowNodeKind,
  position: WorkflowPosition,
): WorkflowDocumentNode {
  const label = formatNodeTitle(kind);

  switch (kind) {
    case "list":
      return {
        id,
        kind,
        label,
        position,
        items: [""],
      };
    case "prompt":
      return {
        id,
        kind,
        label,
        position,
        displayMode: DEFAULT_PROMPT_DISPLAY_MODE,
        prompt:
          "Hyperreal studio portrait of a chrome mannequin under cinematic rim light.",
        variables: [],
      };
    case "asset":
      return {
        id,
        kind,
        label,
        position,
        assetKind: null,
        assets: [],
      };
    case "outputReorder":
      return {
        id,
        kind,
        label,
        position,
        mode: "shift",
        order: [],
        shift: 1,
        valueType: null,
      };
    case "imageGenerator":
      return {
        id,
        kind,
        label,
        position,
        ...createDefaultImageGeneratorSettings(),
        ...createWorkflowGeneratorResult(),
        ...createGeneratorReviewFields(),
      };
    case "videoGenerator":
      return {
        id,
        kind,
        label,
        position,
        ...createDefaultVideoGeneratorSettings(),
        ...createWorkflowGeneratorResult(),
        ...createGeneratorReviewFields(),
      };
    case "llmGenerator":
      return {
        id,
        kind,
        label,
        position,
        ...createDefaultLlmGeneratorSettings(),
        ...createWorkflowLlmResult(),
        ...createGeneratorReviewFields(),
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isWorkflowNodeKind(value: unknown): value is WorkflowNodeKind {
  return (
    value === "list" ||
    value === "prompt" ||
    value === "asset" ||
    value === "outputReorder" ||
    value === "imageGenerator" ||
    value === "videoGenerator" ||
    value === "llmGenerator"
  );
}

function isWorkflowPosition(value: unknown): value is WorkflowPosition {
  return isRecord(value) && isNumber(value.x) && isNumber(value.y);
}

function asString(value: unknown, fallback: string) {
  return isString(value) ? value : fallback;
}

function asPromptDisplayMode(
  value: unknown,
  fallback: PromptDisplayMode,
): PromptDisplayMode {
  return value === "source-value" || value === "value" || value === "source"
    ? value
    : fallback;
}

function asNullableString(value: unknown, fallback: string | null) {
  return value === null ? null : isString(value) ? value : fallback;
}

function asWorkflowAsset(value: unknown): WorkflowAsset | null {
  if (!isRecord(value)) {
    return null;
  }

  const kind = value.kind;
  const source = value.source;
  if (
    (kind !== "image" && kind !== "video") ||
    (source !== "upload" && source !== "generated")
  ) {
    return null;
  }

  return {
    id: asString(value.id, crypto.randomUUID()),
    kind,
    source,
    fileName: asString(value.fileName, "asset"),
    mimeType: asString(value.mimeType, "application/octet-stream"),
    size: isNumber(value.size) ? value.size : 0,
    createdAt: asString(value.createdAt, new Date().toISOString()),
    url: asString(value.url, ""),
    storagePath: asNullableString(value.storagePath, null),
    externalUri: asNullableString(value.externalUri, null),
    model: asNullableString(value.model, null),
  };
}

function asWorkflowAssets(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((asset) => asWorkflowAsset(asset))
    .filter((asset): asset is WorkflowAsset => Boolean(asset));
}

function asMediaOutputs(value: unknown) {
  return Array.isArray(value)
    ? value.map((output) => asWorkflowAssets(output))
    : [];
}

function asTextOutputs(value: unknown) {
  return Array.isArray(value)
    ? value.map((output) => (isString(output) ? output : ""))
    : [];
}

function asReviewOutputStatus(
  value: unknown,
): WorkflowReviewOutput["status"] | null {
  return value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "regenerating"
    ? value
    : null;
}

function asWorkflowReviewOutput(value: unknown): WorkflowReviewOutput | null {
  if (!isRecord(value) || !Number.isInteger(value.outputIndex)) {
    return null;
  }

  const outputIndex = value.outputIndex as number;
  const status = asReviewOutputStatus(value.status);
  if (outputIndex < 0 || !status) {
    return null;
  }

  return {
    assets: asWorkflowAssets(value.assets),
    attempt:
      Number.isInteger(value.attempt) && (value.attempt as number) >= 0
        ? (value.attempt as number)
        : 0,
    executionId: asNullableString(value.executionId, null),
    outputIndex,
    status,
    text: asNullableString(value.text, null),
  };
}

function normalizeGeneratorReviewFields(
  value: Record<string, unknown>,
): GeneratorReviewFields {
  const review = isRecord(value.review) ? value.review : null;
  return {
    review: review
      ? {
          outputs: Array.isArray(review.outputs)
            ? review.outputs
                .map((output) => asWorkflowReviewOutput(output))
                .filter((output): output is WorkflowReviewOutput =>
                  Boolean(output),
                )
                .sort((left, right) => left.outputIndex - right.outputIndex)
            : [],
          sourceNodeId: asNullableString(review.sourceNodeId, null),
          updatedAt: asNullableString(review.updatedAt, null),
          valueType: asOutputReorderValueType(review.valueType),
        }
      : createWorkflowReviewState(),
    reviewEnabled: value.reviewEnabled === true,
  };
}

function asOutputReorderMode(value: unknown): OutputReorderNodeFields["mode"] {
  return value === "manual" ? "manual" : "shift";
}

function asOutputReorderValueType(
  value: unknown,
): OutputReorderNodeFields["valueType"] {
  return value === "text" || value === "image" || value === "video"
    ? value
    : null;
}

function asOutputPermutation(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((entry) =>
        Number.isInteger(entry) && entry >= 0 ? [entry as number] : [],
      )
    : [];
}

function asListItems(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const text = isString(entry) ? entry.trim() : "";
        return text ? [text] : [];
      })
    : [];
}

function asPromptVariables(value: unknown): PromptVariable[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenKeys = new Set<string>();

  return value.flatMap((entry, index) => {
    if (!isRecord(entry)) {
      return [];
    }

    const key = asString(entry.key, "").trim();
    if (!key || seenKeys.has(key)) {
      return [];
    }

    seenKeys.add(key);

    return [
      {
        key,
        label: asString(entry.label, `Variable ${index + 1}`),
      } satisfies PromptVariable,
    ];
  });
}

function inferAssetKindFromAssets(assets: WorkflowAsset[]) {
  if (!assets.length) {
    return null;
  }

  const [firstAsset] = assets;
  if (!firstAsset) {
    return null;
  }

  return assets.every((asset) => asset.kind === firstAsset.kind)
    ? firstAsset.kind
    : null;
}

function normalizeWorkflowNode(
  value: unknown,
  index: number,
): WorkflowDocumentNode | null {
  if (!isRecord(value) || !isWorkflowNodeKind(value.kind)) {
    return null;
  }

  const id = asString(value.id, createWorkflowNodeId());
  const position = isWorkflowPosition(value.position)
    ? snapWorkflowPositionToGrid(value.position)
    : nextNodePosition(index);

  switch (value.kind) {
    case "list": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as ListWorkflowNode;

      return {
        ...baseNode,
        label: asString(value.label, baseNode.label),
        items: asListItems(value.items),
      };
    }
    case "prompt": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as PromptWorkflowNode;
      return {
        ...baseNode,
        displayMode: asPromptDisplayMode(
          value.displayMode,
          baseNode.displayMode,
        ),
        label: asString(value.label, baseNode.label),
        prompt: asString(value.prompt, baseNode.prompt),
        variables: asPromptVariables(value.variables),
      };
    }
    case "asset": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as AssetWorkflowNode;
      const assets = asWorkflowAssets(value.assets);
      const inferredAssetKind = inferAssetKindFromAssets(assets);

      return {
        ...baseNode,
        label: asString(value.label, baseNode.label),
        assetKind:
          value.assetKind === "image" || value.assetKind === "video"
            ? value.assetKind
            : inferredAssetKind,
        assets:
          inferredAssetKind || !assets.length
            ? assets
            : assets.filter((asset) => asset.kind === assets[0]?.kind),
      };
    }
    case "outputReorder": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as OutputReorderWorkflowNode;

      return {
        ...baseNode,
        label: asString(value.label, baseNode.label),
        mode: asOutputReorderMode(value.mode),
        order: asOutputPermutation(value.order),
        shift: isNumber(value.shift) ? Math.trunc(value.shift) : baseNode.shift,
        valueType: asOutputReorderValueType(value.valueType),
      };
    }
    case "imageGenerator": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as ImageGeneratorWorkflowNode;
      const settings = normalizeImageGeneratorSettings({
        model: value.model as ImageGeneratorSettings["model"] | undefined,
        mode: value.mode as string | null | undefined,
        config: isRecord(value.config)
          ? (value.config as ImageGeneratorSettings["config"])
          : {},
      });

      return {
        ...baseNode,
        ...settings,
        label: asString(value.label, baseNode.label),
        lastPrompt: asString(value.lastPrompt, baseNode.lastPrompt),
        outputs: asMediaOutputs(value.outputs),
        ...normalizeGeneratorReviewFields(value),
      };
    }
    case "videoGenerator": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as VideoGeneratorWorkflowNode;
      const settings = normalizeVideoGeneratorSettings({
        model: value.model as VideoGeneratorSettings["model"] | undefined,
        mode: value.mode as string | null | undefined,
        config: isRecord(value.config)
          ? (value.config as VideoGeneratorSettings["config"])
          : {},
      });

      return {
        ...baseNode,
        ...settings,
        label: asString(value.label, baseNode.label),
        lastPrompt: asString(value.lastPrompt, baseNode.lastPrompt),
        outputs: asMediaOutputs(value.outputs),
        ...normalizeGeneratorReviewFields(value),
      };
    }
    case "llmGenerator": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as LlmGeneratorWorkflowNode;
      const settings = normalizeLlmGeneratorSettings({
        model: value.model as LlmGeneratorSettings["model"] | undefined,
        mode: value.mode as string | null | undefined,
        config: isRecord(value.config)
          ? (value.config as LlmGeneratorSettings["config"])
          : {},
      });

      return {
        ...baseNode,
        ...settings,
        label: asString(value.label, baseNode.label),
        lastPrompt: asString(value.lastPrompt, baseNode.lastPrompt),
        lastSystemPrompt: asString(
          value.lastSystemPrompt,
          baseNode.lastSystemPrompt,
        ),
        outputs: asTextOutputs(value.outputs),
        ...normalizeGeneratorReviewFields(value),
      };
    }
  }
}

function normalizeWorkflowDocument(
  document: WorkflowDocument,
): WorkflowDocument {
  const nodes = document.nodes
    .map((node, index) => normalizeWorkflowNode(node, index))
    .filter((node): node is WorkflowDocumentNode => Boolean(node));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = document.edges
    .filter((edge) => isRecord(edge))
    .map((edge) => ({
      id: asString(edge.id, createWorkflowNodeId()),
      source: asString(edge.source, ""),
      sourceHandle: asNullableString(edge.sourceHandle, null),
      target: asString(edge.target, ""),
      targetHandle: asNullableString(edge.targetHandle, null),
    }))
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  return {
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes,
    edges,
  };
}

function isWorkflowDocument(value: unknown): value is WorkflowDocument {
  if (
    !isRecord(value) ||
    value.version !== WORKFLOW_DOCUMENT_VERSION ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  ) {
    return false;
  }

  return value.nodes.every(
    (node) =>
      isRecord(node) &&
      typeof node.id === "string" &&
      isWorkflowNodeKind(node.kind),
  );
}

export function createWorkflowNodeId() {
  return crypto.randomUUID();
}

export function updateWorkflowDocumentNode(
  document: WorkflowDocument,
  nodeId: string,
  updater: (node: WorkflowDocumentNode) => WorkflowDocumentNode,
) {
  return {
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === nodeId ? updater(node) : node,
    ),
  } satisfies WorkflowDocument;
}

export function toWorkflowGraphDocument(
  document: WorkflowDocument | WorkflowGraphDocument,
): WorkflowGraphDocument {
  return document;
}

export function toWorkflowDefinitionGraphDocument(
  document: WorkflowDocument | WorkflowGraphDocument,
): WorkflowDefinitionGraphDocument {
  const hydrated = hydrateWorkflowGraphDocument(
    toWorkflowGraphDocument(document),
  );
  if (!hydrated) {
    return toWorkflowGraphDocument(document);
  }

  return {
    ...hydrated,
    nodes: hydrated.nodes.map((node) => {
      switch (node.kind) {
        case "imageGenerator": {
          const { lastPrompt, outputs, review, ...definitionNode } = node;
          void lastPrompt;
          void outputs;
          void review;
          return definitionNode satisfies ImageGeneratorWorkflowDefinitionNode;
        }
        case "videoGenerator": {
          const { lastPrompt, outputs, review, ...definitionNode } = node;
          void lastPrompt;
          void outputs;
          void review;
          return definitionNode satisfies VideoGeneratorWorkflowDefinitionNode;
        }
        case "llmGenerator": {
          const {
            lastPrompt,
            lastSystemPrompt,
            outputs,
            review,
            ...definitionNode
          } = node;
          void lastPrompt;
          void lastSystemPrompt;
          void outputs;
          void review;
          return definitionNode satisfies LlmGeneratorWorkflowDefinitionNode;
        }
        default:
          return node;
      }
    }),
  } satisfies WorkflowDefinitionGraphDocument;
}

export function specializeWorkflowNodeForValueType(
  node: WorkflowDocumentNode,
  valueType: WorkflowValueType,
) {
  if (
    node.kind === "asset" &&
    (valueType === "image" || valueType === "video")
  ) {
    return {
      ...node,
      assetKind: valueType,
    };
  }

  return node.kind === "outputReorder"
    ? {
        ...node,
        valueType,
      }
    : node;
}
export function createWorkflowNode(
  kind: WorkflowNodeKind,
  index: number,
  position?: WorkflowPosition,
) {
  return makeWorkflowNode(
    createWorkflowNodeId(),
    kind,
    position ? snapWorkflowPositionToGrid(position) : nextNodePosition(index),
  );
}

export function deserializeStoredWorkflowDocument(raw: unknown) {
  if (isWorkflowDocument(raw)) {
    const normalized = normalizeWorkflowDocument(raw);
    return normalized;
  }

  return null;
}

export function deserializeStoredWorkflowGraphDocument(raw: unknown) {
  const document = deserializeStoredWorkflowDocument(raw);
  return document ? toWorkflowGraphDocument(document) : null;
}

export function hydrateWorkflowGraphDocument(
  document: WorkflowDefinitionGraphDocument | WorkflowGraphDocument,
) {
  return deserializeStoredWorkflowDocument(document);
}
