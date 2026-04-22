import {
  createDefaultImageGeneratorSettings,
  createDefaultVideoGeneratorSettings,
  normalizeImageGeneratorSettings,
  normalizeVideoGeneratorSettings,
} from "~/lib/workflow/generator-models";
import {
  formatNodeTitle,
  type WorkflowValueType,
} from "~/lib/workflow/node-definitions";
import type {
  AssetNodeFields,
  ImageGeneratorSettings,
  PromptNodeFields,
  VideoGeneratorSettings,
  WorkflowAsset,
  WorkflowGeneratorResult,
  WorkflowNodeKind,
} from "~/lib/workflow/types";

export const WORKFLOW_DOCUMENT_VERSION = 4;
export const WORKFLOW_STORAGE_KEY = "faceless-factory.workflow.v4";
export const WORKFLOW_GRID_STEP = 20;

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

export type ImageGeneratorWorkflowNode = WorkflowDocumentNodeBase &
  ImageGeneratorSettings &
  WorkflowGeneratorResult & {
    kind: "imageGenerator";
  };

export type VideoGeneratorWorkflowNode = WorkflowDocumentNodeBase &
  VideoGeneratorSettings &
  WorkflowGeneratorResult & {
    kind: "videoGenerator";
  };

export type WorkflowDocumentNode =
  | PromptWorkflowNode
  | AssetWorkflowNode
  | ImageGeneratorWorkflowNode
  | VideoGeneratorWorkflowNode;

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
    responseText: null,
    outputAssets: [],
  };
}

function makeWorkflowNode(
  id: string,
  kind: WorkflowNodeKind,
  position: WorkflowPosition,
): WorkflowDocumentNode {
  const label = formatNodeTitle(kind);

  switch (kind) {
    case "prompt":
      return {
        id,
        kind,
        label,
        position,
        prompt:
          "Hyperreal studio portrait of a chrome mannequin under cinematic rim light.",
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
    case "imageGenerator":
      return {
        id,
        kind,
        label,
        position,
        ...createDefaultImageGeneratorSettings(),
        ...createWorkflowGeneratorResult(),
      };
    case "videoGenerator":
      return {
        id,
        kind,
        label,
        position,
        ...createDefaultVideoGeneratorSettings(),
        ...createWorkflowGeneratorResult(),
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
    value === "prompt" ||
    value === "asset" ||
    value === "imageGenerator" ||
    value === "videoGenerator"
  );
}

function isWorkflowPosition(value: unknown): value is WorkflowPosition {
  return isRecord(value) && isNumber(value.x) && isNumber(value.y);
}

function asString(value: unknown, fallback: string) {
  return isString(value) ? value : fallback;
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
    case "prompt": {
      const baseNode = makeWorkflowNode(
        id,
        value.kind,
        position,
      ) as PromptWorkflowNode;
      return {
        ...baseNode,
        label: asString(value.label, baseNode.label),
        prompt: asString(value.prompt, baseNode.prompt),
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
        responseText: asNullableString(
          value.responseText,
          baseNode.responseText,
        ),
        outputAssets: asWorkflowAssets(value.outputAssets),
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
        responseText: asNullableString(
          value.responseText,
          baseNode.responseText,
        ),
        outputAssets: asWorkflowAssets(value.outputAssets),
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

export function specializeWorkflowNodeForValueType(
  node: WorkflowDocumentNode,
  valueType: WorkflowValueType,
) {
  return node.kind === "asset" &&
    (valueType === "image" || valueType === "video")
    ? {
        ...node,
        assetKind: valueType,
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
