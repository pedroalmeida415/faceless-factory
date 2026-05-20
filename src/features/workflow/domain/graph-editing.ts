import type { WorkflowDataType, WorkflowModelDefinition } from "~/features/workflow/domain/model-catalog";
import { WORKFLOW_MODEL_CATALOG } from "~/features/workflow/domain/model-catalog";
import { createDefaultWorkflowAssetNodeData } from "~/features/workflow/domain/nodes/asset";
import { createDefaultWorkflowImageGenerationNodeData } from "~/features/workflow/domain/nodes/image-generation";
import { createDefaultWorkflowListNodeData } from "~/features/workflow/domain/nodes/list";
import {
  createDefaultWorkflowPromptNodeData,
  PROMPT_VARIABLE_INPUT_CAPACITY,
  PROMPT_VARIABLES_TARGET_HANDLE,
} from "~/features/workflow/domain/nodes/prompt";
import type { WorkflowEdge, WorkflowNode } from "./graph";

export {
  PROMPT_VARIABLE_INPUT_CAPACITY,
  PROMPT_VARIABLES_TARGET_HANDLE,
} from "~/features/workflow/domain/nodes/prompt";

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
      data: createDefaultWorkflowPromptNodeData(),
      id,
      position: input.position,
      type: input.type,
    };
  }

  if (input.type === "list") {
    return {
      data: createDefaultWorkflowListNodeData(),
      id,
      position: input.position,
      type: input.type,
    };
  }

  if (input.type === "asset") {
    return { data: createDefaultWorkflowAssetNodeData(), id, position: input.position, type: input.type };
  }

  return {
    data: createDefaultWorkflowImageGenerationNodeData(),
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

  const targetSocket = getWorkflowTargetSocket(target, connection.targetHandle, modelCatalog);

  if (!targetSocket || !sourceDataType || sourceDataType !== targetSocket.dataType) {
    return false;
  }

  const connectedEdgeCount = edges.filter(
    (edge) => edge.target === target.id && getWorkflowTargetSocketId(edge.targetHandle, target) === targetSocket.id,
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

function getWorkflowTargetSocket(
  node: WorkflowNode,
  targetHandle: string,
  modelCatalog: readonly WorkflowModelDefinition[],
) {
  if (node.type === "imageGeneration") {
    const targetModel = modelCatalog.find((model) => model.modelId === node.data.modelId);
    const targetSocketId = parseWorkflowTargetHandle(targetHandle).socketId;

    return targetModel?.inputSockets.find((socket) => socket.id === targetSocketId) ?? null;
  }

  if (node.type === "prompt") {
    return targetHandle === PROMPT_VARIABLES_TARGET_HANDLE
      ? {
          capacity: PROMPT_VARIABLE_INPUT_CAPACITY,
          dataType: "text",
          id: PROMPT_VARIABLES_TARGET_HANDLE,
          label: "Variables",
          repeatable: true,
          required: false,
        }
      : null;
  }

  return null;
}

function getWorkflowTargetSocketId(targetHandle: string | null | undefined, target: WorkflowNode) {
  if (target.type === "prompt") {
    return targetHandle ?? "";
  }

  return parseWorkflowTargetHandle(targetHandle).socketId;
}
