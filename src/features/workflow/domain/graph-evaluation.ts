import type { WorkflowEdge, WorkflowGraphDraft, WorkflowNode } from "~/features/workflow/domain/graph";
import { parseWorkflowTargetHandle } from "~/features/workflow/domain/graph-editing";
import {
  WORKFLOW_MODEL_CATALOG,
  type WorkflowDataType,
  type WorkflowModelDefinition,
  type WorkflowModelInputSocket,
} from "~/features/workflow/domain/model-catalog";
import { getWorkflowAssetIds, getWorkflowAssetNodeDataType } from "~/features/workflow/domain/nodes/asset";
import { getSortedWorkflowSelectedBatchItems } from "~/features/workflow/domain/nodes/image-generation";
import { getWorkflowListTextValues } from "~/features/workflow/domain/nodes/list";
import {
  getPromptDocumentMentionedVariableIds,
  PROMPT_VARIABLES_TARGET_HANDLE,
  renderPromptDocumentText,
} from "~/features/workflow/domain/nodes/prompt";

export const MAX_BRANCH_COUNT = 50;

export type WorkflowBranchInputReference =
  | { readonly kind: "asset"; readonly assetId: string }
  | { readonly kind: "generated-output"; readonly branchIndex: number; readonly nodeId: string }
  | { readonly kind: "text"; readonly value: string };

export type WorkflowInputStateStatus =
  | "broadcasting"
  | "ignored-optional-no-value"
  | "mismatched"
  | "missing-required"
  | "single"
  | "type-mismatch"
  | "zipping";

export type WorkflowInputEdgeState = {
  readonly dataType?: WorkflowDataType;
  readonly edgeId: string;
  readonly itemCount: number;
  readonly sourceNodeId: string;
  readonly status: WorkflowInputStateStatus;
};

export type WorkflowInputState = {
  readonly capacity: number;
  readonly connectedEdgeCount: number;
  readonly edgeStates: readonly WorkflowInputEdgeState[];
  readonly repeatable: boolean;
  readonly required: boolean;
  readonly socketId: string;
  readonly status: WorkflowInputStateStatus;
  readonly usableEdgeCount: number;
};

export type WorkflowAlignmentError =
  | {
      readonly kind: "branch-count-exceeded";
      readonly branchCount: number;
      readonly maxBranchCount: number;
      readonly nodeId: string;
    }
  | {
      readonly kind: "input-alignment-mismatch";
      readonly counts: readonly { readonly edgeId: string; readonly itemCount: number; readonly socketId: string }[];
      readonly nodeId: string;
    }
  | {
      readonly kind: "input-capacity-exceeded";
      readonly capacity: number;
      readonly connectedEdgeCount: number;
      readonly nodeId: string;
      readonly socketId: string;
    }
  | {
      readonly kind: "invalid-branch-batch-size";
      readonly branchBatchSize: number;
      readonly maxBranchBatchSize: number;
      readonly nodeId: string;
    }
  | { readonly kind: "missing-required-input"; readonly nodeId: string; readonly socketId: string }
  | { readonly kind: "model-not-found"; readonly modelId: string; readonly nodeId: string }
  | {
      readonly kind: "type-mismatch";
      readonly edgeId: string;
      readonly expectedDataType: WorkflowDataType;
      readonly nodeId: string;
      readonly receivedDataType: WorkflowDataType;
      readonly socketId: string;
    };

export type WorkflowEvaluatedBranchInput = {
  readonly edgeId: string;
  readonly ref: WorkflowBranchInputReference;
  readonly socketId: string;
};

export type WorkflowEvaluatedBranch = {
  readonly branchIndex: number;
  readonly inputs: readonly WorkflowEvaluatedBranchInput[];
};

export type WorkflowGenerationNodeEvaluation = {
  readonly branches: readonly WorkflowEvaluatedBranch[];
  readonly fingerprintMaterial: unknown;
  readonly inputStates: readonly WorkflowInputState[];
  readonly nodeId: string;
  readonly summary: {
    readonly branchBatchSize: number;
    readonly branchCount: number;
    readonly generationCostCredits: number;
    readonly status: "blocked" | "valid";
    readonly totalOutputCount: number;
  };
  readonly errors: readonly WorkflowAlignmentError[];
};

type WorkflowSourceValue =
  | { readonly kind: "no-value" }
  | {
      readonly dataType: WorkflowDataType;
      readonly kind: "value";
      readonly refs: readonly WorkflowBranchInputReference[];
    };

type UsableInput = {
  readonly edge: WorkflowEdge;
  readonly refs: readonly WorkflowBranchInputReference[];
  readonly socket: WorkflowModelInputSocket;
};

export function evaluateWorkflowGraph(
  blueprint: WorkflowGraphDraft,
  modelCatalog: readonly WorkflowModelDefinition[] = WORKFLOW_MODEL_CATALOG,
) {
  return blueprint.nodes
    .filter((node) => node.type === "imageGeneration")
    .map((node) => evaluateGenerationNode({ blueprint, modelCatalog, nodeId: node.id }));
}

export function evaluateGenerationNode(input: {
  readonly blueprint: WorkflowGraphDraft;
  readonly modelCatalog?: readonly WorkflowModelDefinition[];
  readonly nodeId: string;
}): WorkflowGenerationNodeEvaluation {
  const modelCatalog = input.modelCatalog ?? WORKFLOW_MODEL_CATALOG;
  const nodesById = new Map(input.blueprint.nodes.map((node) => [node.id, node]));
  const node = nodesById.get(input.nodeId);

  if (!node || node.type !== "imageGeneration") {
    return blockedEvaluation(input.nodeId, 1, [{ kind: "model-not-found", modelId: "", nodeId: input.nodeId }]);
  }

  const model = modelCatalog.find((candidate) => candidate.modelId === node.data.modelId);

  if (!model) {
    return blockedEvaluation(input.nodeId, node.data.branchBatchSize, [
      { kind: "model-not-found", modelId: node.data.modelId, nodeId: node.id },
    ]);
  }

  const incomingEdges = input.blueprint.edges.filter((edge) => edge.target === node.id);
  const errors: WorkflowAlignmentError[] = [];
  const usableInputs: UsableInput[] = [];
  const inputStates = model.inputSockets.map((socket) => {
    const socketEdges = incomingEdges.filter(
      (edge) => parseWorkflowTargetHandle(edge.targetHandle).socketId === socket.id,
    );
    const edgeStates: WorkflowInputEdgeState[] = [];

    if (socketEdges.length > socket.capacity) {
      errors.push({
        capacity: socket.capacity,
        connectedEdgeCount: socketEdges.length,
        kind: "input-capacity-exceeded",
        nodeId: node.id,
        socketId: socket.id,
      });
    }

    for (const edge of socketEdges) {
      const source = nodesById.get(edge.source);
      const sourceValue: WorkflowSourceValue = source
        ? getSourceValue({ edges: input.blueprint.edges, node: source, nodesById, visitedNodeIds: new Set([node.id]) })
        : { kind: "no-value" };

      if (sourceValue.kind === "no-value") {
        edgeStates.push({
          edgeId: edge.id,
          itemCount: 0,
          sourceNodeId: edge.source,
          status: socket.required ? "missing-required" : "ignored-optional-no-value",
        });
        continue;
      }

      if (sourceValue.dataType !== socket.dataType) {
        errors.push({
          edgeId: edge.id,
          expectedDataType: socket.dataType,
          kind: "type-mismatch",
          nodeId: node.id,
          receivedDataType: sourceValue.dataType,
          socketId: socket.id,
        });
        edgeStates.push({
          dataType: sourceValue.dataType,
          edgeId: edge.id,
          itemCount: sourceValue.refs.length,
          sourceNodeId: edge.source,
          status: "type-mismatch",
        });
        continue;
      }

      usableInputs.push({ edge, refs: sourceValue.refs, socket });
      edgeStates.push({
        dataType: sourceValue.dataType,
        edgeId: edge.id,
        itemCount: sourceValue.refs.length,
        sourceNodeId: edge.source,
        status: "single",
      });
    }

    const usableEdgeCount = edgeStates.filter((edgeState) => edgeState.status === "single").length;
    const hasMissingRequired = socket.required && usableEdgeCount === 0;

    if (hasMissingRequired) {
      errors.push({ kind: "missing-required-input", nodeId: node.id, socketId: socket.id });
    }

    return {
      capacity: socket.capacity,
      connectedEdgeCount: socketEdges.length,
      edgeStates,
      repeatable: socket.repeatable,
      required: socket.required,
      socketId: socket.id,
      status: getInitialSocketStatus({ edgeStates, hasMissingRequired, socket }),
      usableEdgeCount,
    } satisfies WorkflowInputState;
  });

  if (node.data.branchBatchSize > model.maxBranchBatchSize) {
    errors.push({
      branchBatchSize: node.data.branchBatchSize,
      kind: "invalid-branch-batch-size",
      maxBranchBatchSize: model.maxBranchBatchSize,
      nodeId: node.id,
    });
  }

  const branchCount = getBranchCount(usableInputs);
  const mismatchedInputs = usableInputs.filter(
    (usableInput) => usableInput.refs.length !== 1 && usableInput.refs.length !== branchCount,
  );

  if (mismatchedInputs.length > 0) {
    errors.push({
      counts: mismatchedInputs.map((usableInput) => ({
        edgeId: usableInput.edge.id,
        itemCount: usableInput.refs.length,
        socketId: usableInput.socket.id,
      })),
      kind: "input-alignment-mismatch",
      nodeId: node.id,
    });
  }

  if (branchCount > MAX_BRANCH_COUNT) {
    errors.push({
      branchCount,
      kind: "branch-count-exceeded",
      maxBranchCount: MAX_BRANCH_COUNT,
      nodeId: node.id,
    });
  }

  const status = errors.length > 0 ? "blocked" : "valid";
  const resolvedInputStates = inputStates.map((inputState) => updateInputStateForBranchCount(inputState, branchCount));
  const totalOutputCount = status === "valid" ? branchCount * node.data.branchBatchSize : 0;
  const branches = status === "valid" ? buildBranches(usableInputs, branchCount) : [];

  return {
    branches,
    errors,
    fingerprintMaterial: {
      branchBatchSize: node.data.branchBatchSize,
      config: node.data.config,
      inputs: branches,
      modelId: node.data.modelId,
    },
    inputStates: resolvedInputStates,
    nodeId: node.id,
    summary: {
      branchBatchSize: node.data.branchBatchSize,
      branchCount: status === "valid" ? branchCount : 0,
      generationCostCredits: totalOutputCount * model.costPerBatchItemCredits,
      status,
      totalOutputCount,
    },
  };
}

function blockedEvaluation(
  nodeId: string,
  branchBatchSize: number,
  errors: readonly WorkflowAlignmentError[],
): WorkflowGenerationNodeEvaluation {
  return {
    branches: [],
    errors,
    fingerprintMaterial: {},
    inputStates: [],
    nodeId,
    summary: {
      branchBatchSize,
      branchCount: 0,
      generationCostCredits: 0,
      status: "blocked",
      totalOutputCount: 0,
    },
  };
}

function getSourceValue(input: {
  readonly edges: readonly WorkflowEdge[];
  readonly node: WorkflowNode;
  readonly nodesById: ReadonlyMap<string, WorkflowNode>;
  readonly visitedNodeIds: ReadonlySet<string>;
}): WorkflowSourceValue {
  const { edges, node, nodesById, visitedNodeIds } = input;

  if (visitedNodeIds.has(node.id)) {
    return { kind: "no-value" };
  }

  if (node.type === "prompt") {
    return getPromptSourceValue({ edges, node, nodesById, visitedNodeIds });
  }

  if (node.type === "list") {
    const refs = getWorkflowListTextValues(node).map(
      (text) => ({ kind: "text", value: text }) satisfies WorkflowBranchInputReference,
    );

    return refs.length > 0 ? { dataType: "text", kind: "value", refs } : { kind: "no-value" };
  }

  if (node.type === "asset") {
    const refs = getWorkflowAssetIds(node).map(
      (assetId) => ({ kind: "asset", assetId }) satisfies WorkflowBranchInputReference,
    );
    const dataType = getWorkflowAssetNodeDataType(node);

    return refs.length > 0 && dataType ? { dataType, kind: "value", refs } : { kind: "no-value" };
  }

  const refs = getSortedWorkflowSelectedBatchItems(node).map(
    (selectedBatchItem) =>
      ({
        branchIndex: selectedBatchItem.branchIndex,
        kind: "generated-output",
        nodeId: node.id,
      }) satisfies WorkflowBranchInputReference,
  );

  return refs.length > 0 ? { dataType: "image", kind: "value", refs } : { kind: "no-value" };
}

function getPromptSourceValue(input: {
  readonly edges: readonly WorkflowEdge[];
  readonly node: Extract<WorkflowNode, { readonly type: "prompt" }>;
  readonly nodesById: ReadonlyMap<string, WorkflowNode>;
  readonly visitedNodeIds: ReadonlySet<string>;
}): WorkflowSourceValue {
  const mentionedVariableIds = getPromptDocumentMentionedVariableIds(input.node.data.document);
  const variableInputs = Array.from(mentionedVariableIds).map((variableId) => {
    const edge = input.edges.find(
      (candidate) =>
        candidate.target === input.node.id &&
        candidate.targetHandle === PROMPT_VARIABLES_TARGET_HANDLE &&
        candidate.source === variableId,
    );

    if (!edge) {
      return { id: variableId, refs: [] as readonly WorkflowBranchInputReference[] };
    }

    const source = input.nodesById.get(edge.source);
    const sourceValue = source
      ? getSourceValue({
          edges: input.edges,
          node: source,
          nodesById: input.nodesById,
          visitedNodeIds: new Set([...input.visitedNodeIds, input.node.id]),
        })
      : { kind: "no-value" as const };

    if (sourceValue.kind === "no-value" || sourceValue.dataType !== "text") {
      return { id: variableId, refs: [] as readonly WorkflowBranchInputReference[] };
    }

    return { id: variableId, refs: sourceValue.refs };
  });

  const usableVariableInputs = variableInputs.filter((variableInput) => variableInput.refs.length > 0);
  const branchCount = usableVariableInputs.reduce(
    (currentBranchCount, variableInput) => Math.max(currentBranchCount, variableInput.refs.length),
    1,
  );

  if (
    usableVariableInputs.some(
      (variableInput) => variableInput.refs.length !== 1 && variableInput.refs.length !== branchCount,
    )
  ) {
    return { kind: "no-value" };
  }

  const refs = Array.from({ length: branchCount }, (_, branchIndex) => {
    const text = renderPromptDocumentText(input.node.data.document, (variableId) => {
      const variableInput = variableInputs.find((candidate) => candidate.id === variableId);
      const ref = variableInput?.refs.length === 1 ? variableInput.refs[0] : variableInput?.refs[branchIndex];

      return ref?.kind === "text" ? ref.value : "";
    }).trim();

    return text ? ({ kind: "text", value: text } satisfies WorkflowBranchInputReference) : null;
  }).filter((ref) => ref !== null);

  return refs.length > 0 ? { dataType: "text", kind: "value", refs } : { kind: "no-value" };
}

function getInitialSocketStatus(input: {
  readonly edgeStates: readonly WorkflowInputEdgeState[];
  readonly hasMissingRequired: boolean;
  readonly socket: WorkflowModelInputSocket;
}): WorkflowInputStateStatus {
  if (input.hasMissingRequired) {
    return "missing-required";
  }

  if (input.edgeStates.some((edgeState) => edgeState.status === "type-mismatch")) {
    return "type-mismatch";
  }

  if (
    !input.socket.required &&
    input.edgeStates.length > 0 &&
    input.edgeStates.every((edgeState) => edgeState.itemCount === 0)
  ) {
    return "ignored-optional-no-value";
  }

  return "single";
}

function getBranchCount(usableInputs: readonly UsableInput[]) {
  return usableInputs.reduce((branchCount, input) => Math.max(branchCount, input.refs.length), 1);
}

function updateInputStateForBranchCount(inputState: WorkflowInputState, branchCount: number): WorkflowInputState {
  const edgeStates = inputState.edgeStates.map((edgeState) => {
    if (edgeState.status !== "single") {
      return edgeState;
    }

    return {
      ...edgeState,
      status: getAlignedStatus(edgeState.itemCount, branchCount),
    } satisfies WorkflowInputEdgeState;
  });

  const usableEdgeStates = edgeStates.filter(
    (edgeState) =>
      edgeState.status === "broadcasting" || edgeState.status === "single" || edgeState.status === "zipping",
  );
  const hasMismatch = usableEdgeStates.some((edgeState) => edgeState.status === "mismatched");

  return {
    ...inputState,
    edgeStates,
    status: hasMismatch ? "mismatched" : getSocketStatusFromEdges(inputState.status, edgeStates),
  };
}

function getAlignedStatus(itemCount: number, branchCount: number): WorkflowInputStateStatus {
  if (itemCount === 1 && branchCount > 1) {
    return "broadcasting";
  }

  if (itemCount === branchCount && branchCount > 1) {
    return "zipping";
  }

  if (itemCount === 1 && branchCount === 1) {
    return "single";
  }

  return "mismatched";
}

function getSocketStatusFromEdges(
  fallback: WorkflowInputStateStatus,
  edgeStates: readonly WorkflowInputEdgeState[],
): WorkflowInputStateStatus {
  if (edgeStates.length === 0) {
    return fallback;
  }

  if (edgeStates.some((edgeState) => edgeState.status === "mismatched")) {
    return "mismatched";
  }

  if (edgeStates.some((edgeState) => edgeState.status === "type-mismatch")) {
    return "type-mismatch";
  }

  if (edgeStates.some((edgeState) => edgeState.status === "zipping")) {
    return "zipping";
  }

  if (edgeStates.some((edgeState) => edgeState.status === "broadcasting")) {
    return "broadcasting";
  }

  return fallback;
}

function buildBranches(usableInputs: readonly UsableInput[], branchCount: number) {
  return Array.from({ length: branchCount }, (_, branchIndex) => {
    const inputs = usableInputs.flatMap((usableInput) => {
      const ref = usableInput.refs.length === 1 ? usableInput.refs[0] : usableInput.refs[branchIndex];

      return ref
        ? [
            {
              edgeId: usableInput.edge.id,
              ref,
              socketId: usableInput.socket.id,
            } satisfies WorkflowEvaluatedBranchInput,
          ]
        : [];
    });

    return { branchIndex, inputs } satisfies WorkflowEvaluatedBranch;
  });
}
