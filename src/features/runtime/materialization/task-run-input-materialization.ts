import {
  type ProviderDependencyAddress,
  providerDependencyAddressKey,
} from "~/features/runtime/domain/provider-dependency-address";
import {
  buildTaskRunInputSnapshot,
  type ExecutableTaskRunInputSnapshot,
} from "~/features/runtime/execution/task-run-input-snapshot";
import { planTaskRunMaterialization } from "~/features/runtime/materialization/planning";
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

export type MaterializeTaskRunInputCommand = {
  readonly taskRunId: string;
  readonly nodeExecutionId: string;
  readonly nodeId: string;
  readonly itemIndex: number;
  readonly attempt: number;
  readonly document: WorkflowDocument;
  readonly documentRevision: number | null;
  readonly materializedInputFacts?: MaterializedProviderInputFacts;
};

export type TaskRunInputMaterializationError = {
  readonly _tag: "TaskRunInputMaterializationError";
  readonly message: string;
};

export type TaskRunInputMaterializationResult =
  | { readonly ok: true; readonly value: ExecutableTaskRunInputSnapshot }
  | { readonly ok: false; readonly error: TaskRunInputMaterializationError };

export type MaterializedProviderInputFacts = {
  readonly dependencyAddresses: readonly ProviderDependencyAddress[];
  readonly imageInputsByHandle: Readonly<
    Record<string, readonly WorkflowAsset[]>
  >;
  readonly prompt: string;
  readonly systemPrompt: string | null;
};

export type MaterializedTaskRunFacts = {
  readonly nodeId: string;
  readonly itemIndex: number;
  readonly dependencyAddresses: readonly ProviderDependencyAddress[];
  readonly error?: TaskRunInputMaterializationError;
  readonly providerInputFacts: MaterializedProviderInputFacts;
};

export type WorkflowRunTaskMaterializationFacts = {
  readonly workflowDefinition: WorkflowDefinitionGraphDocument;
  readonly executableNodeIds: readonly string[];
  readonly itemCountByNodeId: Readonly<Record<string, number>>;
  readonly taskFacts: readonly MaterializedTaskRunFacts[];
};

export type MaterializeWorkflowRunTaskFactsCommand = {
  readonly document: WorkflowDocument;
  readonly targetNodeIds: readonly string[];
  readonly plannedItemCountByNodeId?: Readonly<Record<string, number>>;
};

export type WorkflowRunTaskMaterializationFactsResult =
  | { readonly ok: true; readonly value: WorkflowRunTaskMaterializationFacts }
  | { readonly ok: false; readonly error: TaskRunInputMaterializationError };

export function materializeTaskRunInput(
  command: MaterializeTaskRunInputCommand,
): TaskRunInputMaterializationResult {
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
    const snapshot = buildTaskRunInputSnapshot({
      attempt: command.attempt,
      documentRevision: command.documentRevision,
      itemIndex: command.itemIndex,
      materializedInputFacts:
        command.materializedInputFacts ?? taskFacts?.providerInputFacts,
      nodeExecutionId: command.nodeExecutionId,
      nodeId: command.nodeId,
      resolvedParentTaskRuns: [],
      targetNodeConfig,
      taskRunId: command.taskRunId,
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
        : "Task Run Input Materialization failed.",
    );
  }
}

function materializeSingleTaskFacts(command: MaterializeTaskRunInputCommand) {
  const facts = materializeWorkflowRunTaskFacts({
    document: command.document,
    targetNodeIds: [command.nodeId],
  });
  if (!facts.ok) {
    throw new Error(facts.error.message);
  }
  return facts.value.taskFacts.find(
    (fact) =>
      fact.nodeId === command.nodeId && fact.itemIndex === command.itemIndex,
  );
}

export function materializeWorkflowRunTaskFacts(
  command: MaterializeWorkflowRunTaskFactsCommand,
): WorkflowRunTaskMaterializationFactsResult {
  try {
    const workflowDefinition = toWorkflowDefinitionGraphDocument(
      command.document,
    );
    const schedulingPlan = planTaskRunMaterialization({
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
      Array.from({ length: itemCountByNodeId[nodeId] ?? 1 }, (_, itemIndex) =>
        materializeTaskFactsSafely(context, nodeId, itemIndex),
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
        : "Task Run Input Materialization failed.",
    );
  }
}

function materializationError(
  message: string,
): TaskRunInputMaterializationResult &
  WorkflowRunTaskMaterializationFactsResult {
  return {
    error: { _tag: "TaskRunInputMaterializationError", message },
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
  itemIndex: number,
): MaterializedTaskRunFacts {
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
    itemIndex,
  );
  const dependencyAddresses = uniqueDependencyAddresses([
    ...dependenciesForItem(textInput, itemIndex),
    ...dependenciesForItem(systemPromptInput, itemIndex),
    ...Object.values(imageInputsByHandle.dependenciesByHandle).flat(),
  ]);

  return {
    dependencyAddresses,
    itemIndex,
    nodeId,
    providerInputFacts: {
      dependencyAddresses,
      imageInputsByHandle: imageInputsByHandle.assetsByHandle,
      prompt: textForItem(textInput, itemIndex),
      systemPrompt: textForItem(systemPromptInput, itemIndex) || null,
    },
  };
}

function materializeTaskFactsSafely(
  context: MaterializationTraversalContext,
  nodeId: string,
  itemIndex: number,
): MaterializedTaskRunFacts {
  try {
    return materializeTaskFacts(context, nodeId, itemIndex);
  } catch (cause) {
    const error = {
      _tag: "TaskRunInputMaterializationError" as const,
      message:
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : "Task Run Input Materialization failed.",
    };
    return {
      dependencyAddresses: [],
      error,
      itemIndex,
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
      itemIndex: 0,
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
  itemIndex: number,
) {
  const assetsByHandle: Record<string, WorkflowAsset[]> = {};
  const dependenciesByHandle: Record<string, ProviderDependencyAddress[]> = {};
  for (const edge of context.incomingByTarget.get(nodeId) ?? []) {
    const value = materializeRuntimeValue({
      context,
      edge,
      itemIndex,
      path: new Set(),
      targetHandle: edge.targetHandle,
      targetNodeId: edge.target,
    });
    if (value?.type !== "image" || !edge.targetHandle) {
      continue;
    }
    const assets = getBroadcastOutput(value.items, itemIndex) ?? [];
    if (assets.length) {
      assetsByHandle[edge.targetHandle] = [
        ...(assetsByHandle[edge.targetHandle] ?? []),
        ...assets,
      ];
    }
    dependenciesByHandle[edge.targetHandle] = [
      ...(dependenciesByHandle[edge.targetHandle] ?? []),
      ...dependenciesForItem(value, itemIndex),
    ];
  }
  return { assetsByHandle, dependenciesByHandle };
}

function materializeRuntimeValue(input: {
  readonly context: MaterializationTraversalContext;
  readonly edge?: WorkflowDocumentEdge;
  readonly itemIndex: number;
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
              parentItemIndex: outputCount === 1 ? 0 : index,
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
    readonly itemIndex: number;
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
    itemIndex:
      sourceOutputCount === 1
        ? 0
        : (permutation[input.itemIndex] ?? input.itemIndex),
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
  itemIndex: number,
) {
  return value?.type === "text"
    ? (getBroadcastOutput(value.items, itemIndex) ?? "")
    : "";
}

function dependenciesForItem(
  value: MaterializedRuntimeValue | null,
  itemIndex: number,
) {
  if (!value) {
    return [];
  }
  return value.dependencyAddressesByItem.length === 1
    ? (value.dependencyAddressesByItem[0] ?? [])
    : (value.dependencyAddressesByItem[itemIndex] ?? []);
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
