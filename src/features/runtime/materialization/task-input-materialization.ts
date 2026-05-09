import {
  type ProviderDependencyAddress,
  providerDependencyAddressKey,
} from "~/features/runtime/domain/provider-dependency-address";
import {
  buildTaskInputSnapshot,
  type ExecutableTaskInputSnapshot,
} from "~/features/runtime/execution/task-input-snapshot";
import { planTaskMaterialization } from "~/features/runtime/materialization/planning";
import {
  toWorkflowDefinitionGraphDocument,
  type WorkflowDefinitionGraphDocument,
  type WorkflowDocument,
  type WorkflowDocumentEdge,
  type WorkflowDocumentNode,
} from "~/features/workflow/document";
import {
  buildIncomingByTarget,
  buildTextRuntimeValue,
  getIncomingEdgesForHandle,
  getPromptNodeReferencedVariableKeys,
} from "~/features/workflow/graph";
import {
  OUTPUT_REORDER_INPUT_HANDLE_ID,
  PROMPT_INPUT_HANDLE_ID,
} from "~/features/workflow/node-definitions";
import {
  getBroadcastOutput,
  type RuntimeValue,
  reorderRuntimeValue,
  resolveOutputPermutation,
} from "~/features/workflow/runtime-values";
import type { WorkflowAsset } from "~/features/workflow/types";
import { isGeneratorNodeKind } from "~/features/workflow/types";

export type MaterializeTaskInputCommand = {
  readonly taskId: string;
  readonly nodeRunId: string;
  readonly nodeId: string;
  readonly branchIndex: number;
  readonly document: WorkflowDocument;
  readonly documentRevision: number | null;
  readonly materializedInputFacts?: MaterializedProviderInputFacts;
};

export type TaskInputMaterializationError = {
  readonly _tag: "TaskInputMaterializationError";
  readonly message: string;
};

export type TaskInputMaterializationResult =
  | { readonly ok: true; readonly value: ExecutableTaskInputSnapshot }
  | { readonly ok: false; readonly error: TaskInputMaterializationError };

export type MaterializedProviderInputFacts = {
  readonly dependencyAddresses: readonly ProviderDependencyAddress[];
  readonly imageInputsByHandle: Readonly<
    Record<string, readonly WorkflowAsset[]>
  >;
  readonly prompt: string;
  readonly systemPrompt: string | null;
};

export type MaterializedTaskFacts = {
  readonly nodeId: string;
  readonly branchIndex: number;
  readonly dependencyAddresses: readonly ProviderDependencyAddress[];
  readonly error?: TaskInputMaterializationError;
  readonly providerInputFacts: MaterializedProviderInputFacts;
};

export type WorkflowRunTaskMaterializationFacts = {
  readonly workflowDefinition: WorkflowDefinitionGraphDocument;
  readonly executableNodeIds: readonly string[];
  readonly itemCountByNodeId: Readonly<Record<string, number>>;
  readonly taskFacts: readonly MaterializedTaskFacts[];
};

export type MaterializeWorkflowRunTaskFactsCommand = {
  readonly document: WorkflowDocument;
  readonly targetNodeIds: readonly string[];
  readonly plannedItemCountByNodeId?: Readonly<Record<string, number>>;
};

export type WorkflowRunTaskMaterializationFactsResult =
  | { readonly ok: true; readonly value: WorkflowRunTaskMaterializationFacts }
  | { readonly ok: false; readonly error: TaskInputMaterializationError };

export function materializeTaskInput(
  command: MaterializeTaskInputCommand,
): TaskInputMaterializationResult {
  const workflowDefinition = toWorkflowDefinitionGraphDocument(
    command.document,
  );
  const targetNodeConfig = workflowDefinition.nodes.find(
    (node) => node.id === command.nodeId,
  );
  if (!targetNodeConfig) {
    return materializationError(`Missing target node ${command.nodeId}.`);
  }
  if (!isGeneratorNodeKind(targetNodeConfig.kind)) {
    return materializationError(
      `Node kind ${targetNodeConfig.kind} is not executable by the provider runtime.`,
    );
  }

  try {
    const taskFacts = command.materializedInputFacts
      ? undefined
      : materializeSingleTaskFacts(command);
    if (taskFacts?.error) {
      return { error: taskFacts.error, ok: false };
    }
    const snapshot = buildTaskInputSnapshot({
      documentRevision: command.documentRevision,
      branchIndex: command.branchIndex,
      materializedInputFacts:
        command.materializedInputFacts ?? taskFacts?.providerInputFacts,
      nodeRunId: command.nodeRunId,
      nodeId: command.nodeId,
      resolvedParentTasks: [],
      targetNodeConfig,
      taskId: command.taskId,
      workflowDefinition,
    });
    if (snapshot.providerInput.kind === "non-executable-node") {
      return materializationError(snapshot.providerInput.message);
    }

    return {
      ok: true,
      value: { ...snapshot, providerInput: snapshot.providerInput },
    };
  } catch (cause) {
    return materializationError(
      cause instanceof Error && cause.message.length > 0
        ? cause.message
        : "Task Input Materialization failed.",
    );
  }
}

function materializeSingleTaskFacts(command: MaterializeTaskInputCommand) {
  const facts = materializeWorkflowRunTaskFacts({
    document: command.document,
    targetNodeIds: [command.nodeId],
  });
  if (!facts.ok) {
    throw new Error(facts.error.message);
  }
  return facts.value.taskFacts.find(
    (fact) =>
      fact.nodeId === command.nodeId &&
      fact.branchIndex === command.branchIndex,
  );
}

export function materializeWorkflowRunTaskFacts(
  command: MaterializeWorkflowRunTaskFactsCommand,
): WorkflowRunTaskMaterializationFactsResult {
  try {
    const workflowDefinition = toWorkflowDefinitionGraphDocument(
      command.document,
    );
    const schedulingPlan = planTaskMaterialization({
      document: command.document,
      targetNodeIds: command.targetNodeIds,
    });
    const context: MaterializationTraversalContext = {
      getOutputCount: (nodeId, sourceHandleId) =>
        command.plannedItemCountByNodeId?.[nodeId] ??
        schedulingPlan.getOutputCount(nodeId, sourceHandleId),
      incomingByTarget: buildIncomingByTarget(command.document.edges),
      nodeById: new Map(command.document.nodes.map((node) => [node.id, node])),
    };
    const executableNodeIds = schedulingPlan.executableNodeIds.filter(
      (nodeId) => Boolean(context.nodeById.get(nodeId)),
    );
    const itemCountByNodeId = Object.fromEntries(
      executableNodeIds.map((nodeId) => [
        nodeId,
        Math.max(1, context.getOutputCount(nodeId)),
      ]),
    );
    const taskFacts = executableNodeIds.flatMap((nodeId) =>
      Array.from({ length: itemCountByNodeId[nodeId] ?? 1 }, (_, branchIndex) =>
        materializeTaskFactsSafely(context, nodeId, branchIndex),
      ),
    );

    return {
      ok: true,
      value: {
        executableNodeIds,
        itemCountByNodeId,
        taskFacts,
        workflowDefinition,
      },
    };
  } catch (cause) {
    return materializationError(
      cause instanceof Error && cause.message.length > 0
        ? cause.message
        : "Task Input Materialization failed.",
    );
  }
}

function materializationError(
  message: string,
): TaskInputMaterializationResult & WorkflowRunTaskMaterializationFactsResult {
  return {
    error: { _tag: "TaskInputMaterializationError", message },
    ok: false,
  };
}

type MaterializationTraversalContext = {
  readonly incomingByTarget: ReturnType<typeof buildIncomingByTarget>;
  readonly nodeById: ReadonlyMap<string, WorkflowDocumentNode>;
  readonly getOutputCount: (
    nodeId: string,
    sourceHandleId?: string | null,
  ) => number;
};

type MaterializedRuntimeValue = RuntimeValue & {
  readonly dependencyAddressesByItem: readonly (readonly ProviderDependencyAddress[])[];
};

function materializeTaskFacts(
  context: MaterializationTraversalContext,
  nodeId: string,
  branchIndex: number,
): MaterializedTaskFacts {
  const textInput = materializeTextHandle(
    context,
    nodeId,
    PROMPT_INPUT_HANDLE_ID,
  );
  const systemPromptInput = materializeTextHandle(
    context,
    nodeId,
    "systemPrompt",
  );
  const imageInputsByHandle = materializeImageInputsByHandle(
    context,
    nodeId,
    branchIndex,
  );
  const dependencyAddresses = uniqueDependencyAddresses([
    ...dependenciesForItem(textInput, branchIndex),
    ...dependenciesForItem(systemPromptInput, branchIndex),
    ...Object.values(imageInputsByHandle.dependenciesByHandle).flat(),
  ]);

  return {
    dependencyAddresses,
    branchIndex,
    nodeId,
    providerInputFacts: {
      dependencyAddresses,
      imageInputsByHandle: imageInputsByHandle.assetsByHandle,
      prompt: textForItem(textInput, branchIndex),
      systemPrompt: textForItem(systemPromptInput, branchIndex) || null,
    },
  };
}

function materializeTaskFactsSafely(
  context: MaterializationTraversalContext,
  nodeId: string,
  branchIndex: number,
): MaterializedTaskFacts {
  try {
    return materializeTaskFacts(context, nodeId, branchIndex);
  } catch (cause) {
    const error = {
      _tag: "TaskInputMaterializationError" as const,
      message:
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : "Task Input Materialization failed.",
    };
    return {
      dependencyAddresses: [],
      error,
      branchIndex,
      nodeId,
      providerInputFacts: {
        dependencyAddresses: [],
        imageInputsByHandle: {},
        prompt: "",
        systemPrompt: null,
      },
    };
  }
}

function materializeTextHandle(
  context: MaterializationTraversalContext,
  nodeId: string,
  handleId: string,
) {
  const values = getIncomingEdgesForHandle(
    context.incomingByTarget,
    nodeId,
    handleId,
  ).flatMap((edge) => {
    const value = materializeRuntimeValue({
      context,
      edge,
      branchIndex: 0,
      path: new Set(),
      targetHandle: edge.targetHandle,
      targetNodeId: edge.target,
    });
    return value?.type === "text" ? [value] : [];
  });
  const staticValues = values.filter((value) =>
    value.items.some((item) => item.trim()),
  );
  const textValue = staticValues.length
    ? buildTextRuntimeValue(staticValues)
    : null;
  const outputCount = Math.max(
    textValue?.items.length ?? 0,
    ...values.map((value) => value.dependencyAddressesByItem.length),
  );
  if (!outputCount) {
    return null;
  }
  return {
    items: textValue?.items ?? Array.from({ length: outputCount }, () => ""),
    type: "text" as const,
    dependencyAddressesByItem: Array.from({ length: outputCount }, (_, index) =>
      uniqueDependencyAddresses(
        values.flatMap((value) => dependenciesForItem(value, index)),
      ),
    ),
  } satisfies MaterializedRuntimeValue;
}

function materializeImageInputsByHandle(
  context: MaterializationTraversalContext,
  nodeId: string,
  branchIndex: number,
) {
  const assetsByHandle: Record<string, WorkflowAsset[]> = {};
  const dependenciesByHandle: Record<string, ProviderDependencyAddress[]> = {};
  for (const edge of context.incomingByTarget.get(nodeId) ?? []) {
    const value = materializeRuntimeValue({
      context,
      edge,
      branchIndex,
      path: new Set(),
      targetHandle: edge.targetHandle,
      targetNodeId: edge.target,
    });
    if (value?.type !== "image" || !edge.targetHandle) {
      continue;
    }
    const assets = getBroadcastOutput(value.items, branchIndex) ?? [];
    if (assets.length) {
      assetsByHandle[edge.targetHandle] = [
        ...(assetsByHandle[edge.targetHandle] ?? []),
        ...assets,
      ];
    }
    dependenciesByHandle[edge.targetHandle] = [
      ...(dependenciesByHandle[edge.targetHandle] ?? []),
      ...dependenciesForItem(value, branchIndex),
    ];
  }
  return { assetsByHandle, dependenciesByHandle };
}

function materializeRuntimeValue(input: {
  readonly context: MaterializationTraversalContext;
  readonly edge?: WorkflowDocumentEdge;
  readonly branchIndex: number;
  readonly nodeId?: string;
  readonly path: ReadonlySet<string>;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
  readonly targetNodeId: string;
}): MaterializedRuntimeValue | null {
  const nodeId = input.nodeId ?? input.edge?.source;
  if (!nodeId || input.path.has(nodeId)) {
    return null;
  }
  const node = input.context.nodeById.get(nodeId);
  if (!node) {
    return null;
  }
  const nextPath = new Set(input.path);
  nextPath.add(nodeId);

  switch (node.kind) {
    case "list": {
      const items = node.items.map((item) => item.trim()).filter(Boolean);
      return items.length
        ? {
            dependencyAddressesByItem: items.map(() => []),
            items,
            type: "text",
          }
        : null;
    }
    case "asset":
      return node.assetKind && node.assets.length
        ? {
            dependencyAddressesByItem: node.assets.map(() => []),
            items: node.assets.map((asset) => [asset]),
            type: node.assetKind,
          }
        : null;
    case "prompt":
      return materializePromptValue(input.context, node, nextPath, input);
    case "outputReorder":
      return materializeOutputReorderValue(
        input.context,
        node,
        nextPath,
        input,
      );
    case "imageGenerator":
    case "videoGenerator":
    case "llmGenerator": {
      const outputCount = input.context.getOutputCount(
        node.id,
        input.edge?.sourceHandle ?? input.sourceHandle,
      );
      return {
        dependencyAddressesByItem: Array.from(
          { length: outputCount },
          (_, index) => [
            {
              parentBranchIndex: outputCount === 1 ? 0 : index,
              parentNodeId: node.id,
              sourceHandle:
                input.edge?.sourceHandle ?? input.sourceHandle ?? null,
              targetHandle: input.targetHandle ?? null,
              targetNodeId: input.targetNodeId,
            } satisfies ProviderDependencyAddress,
          ],
        ),
        items: Array.from({ length: outputCount }, () =>
          node.kind === "llmGenerator" ? "" : [],
        ),
        type:
          node.kind === "llmGenerator"
            ? "text"
            : node.kind === "imageGenerator"
              ? "image"
              : "video",
      } as MaterializedRuntimeValue;
    }
  }
}

function materializePromptValue(
  context: MaterializationTraversalContext,
  node: Extract<WorkflowDocumentNode, { kind: "prompt" }>,
  path: ReadonlySet<string>,
  input: {
    readonly targetHandle?: string | null;
    readonly targetNodeId: string;
  },
): MaterializedRuntimeValue | null {
  const variableEntries = getPromptNodeReferencedVariableKeys(node).flatMap(
    (key) => {
      const value = materializeTextHandle(context, node.id, key);
      return value ? [[key, value] as const] : [];
    },
  );
  void path;
  const outputCount = Math.max(
    1,
    ...variableEntries.map(([, value]) => value.items.length),
  );
  const variableKeys = new Set(node.variables.map((variable) => variable.key));
  const items = Array.from({ length: outputCount }, (_, index) =>
    node.prompt
      .replace(/{{\s*([\w-]+)\s*}}/g, (match, key: string) => {
        if (!variableKeys.has(key)) {
          return match;
        }
        const value = variableEntries.find(
          ([candidate]) => candidate === key,
        )?.[1];
        return value ? (getBroadcastOutput(value.items, index) ?? "") : "";
      })
      .trim(),
  ).filter(Boolean);
  const dependencies = Array.from(
    { length: Math.max(1, items.length) },
    (_, index) =>
      uniqueDependencyAddresses(
        variableEntries.flatMap(([, value]) =>
          dependenciesForItem(value, index).map((address) => ({
            ...address,
            targetHandle: input.targetHandle ?? address.targetHandle,
            targetNodeId: input.targetNodeId,
          })),
        ),
      ),
  );
  return items.length
    ? { dependencyAddressesByItem: dependencies, items, type: "text" }
    : null;
}

function materializeOutputReorderValue(
  context: MaterializationTraversalContext,
  node: Extract<WorkflowDocumentNode, { kind: "outputReorder" }>,
  path: ReadonlySet<string>,
  input: {
    readonly branchIndex: number;
    readonly targetHandle?: string | null;
    readonly targetNodeId: string;
  },
): MaterializedRuntimeValue | null {
  const edge = getIncomingEdgesForHandle(
    context.incomingByTarget,
    node.id,
    OUTPUT_REORDER_INPUT_HANDLE_ID,
  )[0];
  if (!edge) {
    return null;
  }
  const sourceOutputCount = context.getOutputCount(
    edge.source,
    edge.sourceHandle,
  );
  const permutation = resolveOutputPermutation({
    mode: node.mode,
    order: node.order,
    outputCount: sourceOutputCount,
    shift: node.shift,
  });
  const value = materializeRuntimeValue({
    context,
    edge,
    branchIndex:
      sourceOutputCount === 1
        ? 0
        : (permutation[input.branchIndex] ?? input.branchIndex),
    path,
    targetHandle: input.targetHandle,
    targetNodeId: input.targetNodeId,
  });
  if (!value || value.type !== node.valueType) {
    return null;
  }
  const reorderedValue = reorderRuntimeValue(value, permutation);
  return {
    ...reorderedValue,
    dependencyAddressesByItem: permutation.map(
      (index) => value.dependencyAddressesByItem[index] ?? [],
    ),
  };
}

function textForItem(
  value: MaterializedRuntimeValue | null,
  branchIndex: number,
) {
  return value?.type === "text"
    ? (getBroadcastOutput(value.items, branchIndex) ?? "")
    : "";
}

function dependenciesForItem(
  value: MaterializedRuntimeValue | null,
  branchIndex: number,
) {
  if (!value) {
    return [];
  }
  return value.dependencyAddressesByItem.length === 1
    ? (value.dependencyAddressesByItem[0] ?? [])
    : (value.dependencyAddressesByItem[branchIndex] ?? []);
}

function uniqueDependencyAddresses(
  dependencies: readonly ProviderDependencyAddress[],
) {
  const seen = new Set<string>();
  return dependencies.filter((dependency) => {
    const key = providerDependencyAddressKey(dependency);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
