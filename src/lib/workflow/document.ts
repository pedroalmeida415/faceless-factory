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
  LaneAccumulatorNodeFields,
  LaneMergeNodeFields,
  LaneReorderNodeFields,
  LaneSelectNodeFields,
  LaneSplitNodeFields,
  LaneZipAlignNodeFields,
  ListNodeFields,
  LlmGeneratorSettings,
  PromptDisplayMode,
  PromptNodeFields,
  PromptVariable,
  VideoGeneratorSettings,
  WorkflowAsset,
  WorkflowGeneratorResult,
  WorkflowLlmResult,
  WorkflowNodeKind,
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

export type LaneReorderWorkflowNode = WorkflowDocumentNodeBase &
  LaneReorderNodeFields & {
    kind: "laneReorder";
  };

export type LaneSelectWorkflowNode = WorkflowDocumentNodeBase &
  LaneSelectNodeFields & {
    kind: "laneSelect";
  };

export type LaneSplitWorkflowNode = WorkflowDocumentNodeBase &
  LaneSplitNodeFields & {
    kind: "laneSplit";
  };

export type LaneMergeWorkflowNode = WorkflowDocumentNodeBase &
  LaneMergeNodeFields & {
    kind: "laneMerge";
  };

export type LaneZipAlignWorkflowNode = WorkflowDocumentNodeBase &
  LaneZipAlignNodeFields & {
    kind: "laneZipAlign";
  };

export type LaneAccumulatorWorkflowNode = WorkflowDocumentNodeBase &
  LaneAccumulatorNodeFields & {
    kind: "laneAccumulator";
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

export type WorkflowDocumentNode =
  | PromptWorkflowNode
  | ListWorkflowNode
  | AssetWorkflowNode
  | LaneReorderWorkflowNode
  | LaneSelectWorkflowNode
  | LaneSplitWorkflowNode
  | LaneMergeWorkflowNode
  | LaneZipAlignWorkflowNode
  | LaneAccumulatorWorkflowNode
  | ImageGeneratorWorkflowNode
  | VideoGeneratorWorkflowNode
  | LlmGeneratorWorkflowNode;

type ImageGeneratorGraphWorkflowNode = WorkflowDocumentNodeBase &
  ImageGeneratorSettings &
  Pick<GeneratorReviewFields, "reviewEnabled"> & {
    kind: "imageGenerator";
  };

type VideoGeneratorGraphWorkflowNode = WorkflowDocumentNodeBase &
  VideoGeneratorSettings &
  Pick<GeneratorReviewFields, "reviewEnabled"> & {
    kind: "videoGenerator";
  };

type LlmGeneratorGraphWorkflowNode = WorkflowDocumentNodeBase &
  LlmGeneratorSettings &
  Pick<GeneratorReviewFields, "reviewEnabled"> & {
    kind: "llmGenerator";
  };

type WorkflowGraphDocumentNode =
  | PromptWorkflowNode
  | ListWorkflowNode
  | AssetWorkflowNode
  | LaneReorderWorkflowNode
  | LaneSelectWorkflowNode
  | LaneSplitWorkflowNode
  | LaneMergeWorkflowNode
  | LaneZipAlignWorkflowNode
  | LaneAccumulatorWorkflowNode
  | ImageGeneratorGraphWorkflowNode
  | VideoGeneratorGraphWorkflowNode
  | LlmGeneratorGraphWorkflowNode;

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
    outputLanes: [],
  };
}

function createWorkflowLlmResult(): WorkflowLlmResult {
  return {
    lastPrompt: "",
    lastSystemPrompt: "",
    outputLanes: [],
  };
}

function createWorkflowReviewState(): WorkflowReviewState {
  return {
    lanes: [],
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
    case "laneReorder":
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
    case "laneSelect":
      return {
        id,
        kind,
        label,
        position,
        indices: [0],
        valueType: null,
      };
    case "laneSplit":
      return {
        id,
        kind,
        label,
        position,
        splitCount: 2,
        valueType: null,
      };
    case "laneMerge":
      return {
        id,
        kind,
        label,
        position,
        valueType: null,
      };
    case "laneZipAlign":
      return {
        id,
        kind,
        label,
        position,
        mode: "zip",
        valueType: null,
      };
    case "laneAccumulator":
      return {
        id,
        kind,
        label,
        position,
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
    value === "laneReorder" ||
    value === "laneSelect" ||
    value === "laneSplit" ||
    value === "laneMerge" ||
    value === "laneZipAlign" ||
    value === "laneAccumulator" ||
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

function normalizeGeneratorReviewFields(
  value: Record<string, unknown>,
): GeneratorReviewFields {
  return {
    review: createWorkflowReviewState(),
    reviewEnabled: value.reviewEnabled === true,
  };
}

function asLaneReorderMode(value: unknown): LaneReorderNodeFields["mode"] {
  return value === "manual" ? "manual" : "shift";
}

function asLaneReorderValueType(
  value: unknown,
): LaneReorderNodeFields["valueType"] {
  return value === "text" || value === "image" || value === "video"
    ? value
    : null;
}

function asLaneZipAlignMode(value: unknown): LaneZipAlignNodeFields["mode"] {
  return value === "broadcast" ? "broadcast" : "zip";
}

function asPositiveInteger(value: unknown, fallback: number) {
  return isNumber(value) && value > 0 ? Math.trunc(value) : fallback;
}

function asLanePermutation(value: unknown) {
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
    case "laneReorder": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as LaneReorderWorkflowNode;

      return {
        ...baseNode,
        label: asString(value.label, baseNode.label),
        mode: asLaneReorderMode(value.mode),
        order: asLanePermutation(value.order),
        shift: isNumber(value.shift) ? Math.trunc(value.shift) : baseNode.shift,
        valueType: asLaneReorderValueType(value.valueType),
      };
    }
    case "laneSelect": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as LaneSelectWorkflowNode;

      return {
        ...baseNode,
        label: asString(value.label, baseNode.label),
        indices: asLanePermutation(value.indices),
        valueType: asLaneReorderValueType(value.valueType),
      };
    }
    case "laneSplit": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as LaneSplitWorkflowNode;

      return {
        ...baseNode,
        label: asString(value.label, baseNode.label),
        splitCount: asPositiveInteger(value.splitCount, baseNode.splitCount),
        valueType: asLaneReorderValueType(value.valueType),
      };
    }
    case "laneMerge": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as LaneMergeWorkflowNode;

      return {
        ...baseNode,
        label: asString(value.label, baseNode.label),
        valueType: asLaneReorderValueType(value.valueType),
      };
    }
    case "laneZipAlign": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as LaneZipAlignWorkflowNode;

      return {
        ...baseNode,
        label: asString(value.label, baseNode.label),
        mode: asLaneZipAlignMode(value.mode),
        valueType: asLaneReorderValueType(value.valueType),
      };
    }
    case "laneAccumulator": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as LaneAccumulatorWorkflowNode;

      return {
        ...baseNode,
        label: asString(value.label, baseNode.label),
        valueType: asLaneReorderValueType(value.valueType),
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
  return {
    ...document,
    nodes: document.nodes.map((node) => {
      if (node.kind === "imageGenerator" || node.kind === "videoGenerator") {
        const { lastPrompt, outputLanes, review, ...graphNode } = node as
          | ImageGeneratorWorkflowNode
          | VideoGeneratorWorkflowNode;
        return graphNode;
      }

      if (node.kind === "llmGenerator") {
        const {
          lastPrompt,
          lastSystemPrompt,
          outputLanes,
          review,
          ...graphNode
        } = node as LlmGeneratorWorkflowNode;
        return graphNode;
      }

      return node;
    }),
  } satisfies WorkflowGraphDocument;
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

  return node.kind === "laneReorder" ||
    node.kind === "laneSelect" ||
    node.kind === "laneSplit" ||
    node.kind === "laneMerge" ||
    node.kind === "laneZipAlign" ||
    node.kind === "laneAccumulator"
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

export function hydrateWorkflowGraphDocument(document: WorkflowGraphDocument) {
  return deserializeStoredWorkflowDocument(document);
}
