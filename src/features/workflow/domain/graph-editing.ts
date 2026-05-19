import type { WorkflowDataType, WorkflowModelDefinition } from "~/features/workflow/domain/model-catalog";
import { NANO_BANANA_PRO_MODEL, WORKFLOW_MODEL_CATALOG } from "~/features/workflow/domain/model-catalog";
import type { WorkflowEdge, WorkflowNode } from "./graph";

type WorkflowPosition = WorkflowNode["position"];

export type WorkflowConnectionDraft = {
  readonly source: string | null;
  readonly sourceHandle?: string | null;
  readonly target: string | null;
  readonly targetHandle?: string | null;
};

type CreateWorkflowNodeInput = {
  readonly position: WorkflowPosition;
  readonly type: WorkflowNode["type"];
};

export function createWorkflowNode(input: CreateWorkflowNodeInput): WorkflowNode {
  const id = `${input.type}-${crypto.randomUUID()}`;

  if (input.type === "prompt") {
    return {
      data: { text: "" },
      id,
      position: input.position,
      type: input.type,
    };
  }

  if (input.type === "list") {
    return {
      data: { items: [{ id: `item-${crypto.randomUUID()}`, text: "" }] },
      id,
      position: input.position,
      type: input.type,
    };
  }

  if (input.type === "asset") {
    return { data: { assets: [] }, id, position: input.position, type: input.type };
  }

  return {
    data: {
      branchBatchSize: 1,
      config: NANO_BANANA_PRO_MODEL.defaultConfig,
      modelId: NANO_BANANA_PRO_MODEL.modelId,
      selectedBatchItems: [],
    },
    id,
    position: input.position,
    type: input.type,
  };
}

export function isWorkflowConnectionAllowed(input: {
  readonly connection: WorkflowConnectionDraft;
  readonly edges: readonly WorkflowEdge[];
  readonly modelCatalog?: readonly WorkflowModelDefinition[];
  readonly nodes: readonly WorkflowNode[];
}) {
  const modelCatalog = input.modelCatalog ?? WORKFLOW_MODEL_CATALOG;
  const { connection, edges, nodes } = input;

  if (!connection.source || !connection.target || !connection.targetHandle) {
    return false;
  }

  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);

  if (!source || !target) {
    return false;
  }

  const sourceDataType = getWorkflowNodeOutputDataType(source, modelCatalog);

  if (target.type !== "imageGeneration") {
    return false;
  }

  const targetModel = modelCatalog.find((model) => model.modelId === target.data.modelId);
  const targetSocketId = parseWorkflowTargetHandle(connection.targetHandle).socketId;
  const targetSocket = targetModel?.inputSockets.find((socket) => socket.id === targetSocketId);

  if (!targetSocket || !sourceDataType || sourceDataType !== targetSocket.dataType) {
    return false;
  }

  const connectedEdgeCount = edges.filter(
    (edge) => edge.target === target.id && parseWorkflowTargetHandle(edge.targetHandle).socketId === targetSocket.id,
  ).length;

  return connectedEdgeCount < targetSocket.capacity;
}

export function parseWorkflowTargetHandle(targetHandle: string | null | undefined) {
  if (!targetHandle) {
    return { slotIndex: null, socketId: "" };
  }

  const [socketId, slotIndexText] = targetHandle.split(":");

  if (!socketId) {
    return { slotIndex: null, socketId: "" };
  }

  if (slotIndexText === undefined) {
    return { slotIndex: null, socketId };
  }

  const slotIndex = Number(slotIndexText);

  return Number.isInteger(slotIndex) && slotIndex >= 0 ? { slotIndex, socketId } : { slotIndex: null, socketId };
}

function getWorkflowNodeOutputDataType(
  node: WorkflowNode,
  modelCatalog: readonly WorkflowModelDefinition[],
): WorkflowDataType | null {
  if (node.type === "prompt" || node.type === "list") {
    return "text";
  }

  if (node.type === "asset") {
    return "image";
  }

  return modelCatalog.find((model) => model.modelId === node.data.modelId)?.generationKind ?? null;
}
