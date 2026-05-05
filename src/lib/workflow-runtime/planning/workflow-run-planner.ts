import {
  toWorkflowDefinitionGraphDocument,
  type WorkflowDefinitionDocumentNode,
  type WorkflowDefinitionGraphDocument,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import { WorkflowExecutionPlanner } from "~/lib/workflow/execution/planning";
import {
  buildIncomingByTarget,
  getIncomingEdgesForHandle,
  getPromptNodeReferencedVariableKeys,
} from "~/lib/workflow/graph";
import { OUTPUT_REORDER_INPUT_HANDLE_ID } from "~/lib/workflow/node-definitions";
import type { WorkflowRuntimeEstimatedCreditCostByNodeId } from "~/lib/workflow/pricing";
import { parseWorkflowBlueprint } from "~/lib/workflow/runtime/planning/blueprint/parser";
import { resolveOutputPermutation } from "~/lib/workflow/runtime-values";
import { isGeneratorNodeKind } from "~/lib/workflow/types";
import {
  type ProviderDependencyAddress,
  providerDependencyAddressKey,
} from "~/lib/workflow-runtime/domain/provider-dependency-address";
import {
  isActiveTaskRunStatus,
  isRecoverableByDownstreamPlanningStatus,
  isTaskRunDependencySatisfiedStatus,
  type TaskRunStatus,
} from "~/lib/workflow-runtime/domain/task-run-state";

export type WorkflowRunPlannerCommand =
  | { readonly type: "run-target"; readonly targetNodeIds: readonly string[] }
  | { readonly type: "rerun-node"; readonly nodeId: string }
  | {
      readonly type: "regenerate-item";
      readonly nodeExecutionId: string;
      readonly itemIndexes: readonly number[];
    };

export type ExistingNodeExecution = {
  readonly id: string;
  readonly nodeId: string;
};

export type ExistingTaskRun = {
  readonly id: string;
  readonly nodeExecutionId: string;
  readonly itemIndex: number;
  readonly attempt: number;
  readonly status: TaskRunStatus;
};

export type WorkflowRunPlannerInput = {
  readonly command: WorkflowRunPlannerCommand;
  readonly createNodeExecutionId?: () => string;
  readonly createTaskRunId?: () => string;
  readonly document: WorkflowDocument;
  readonly latestNodeExecutions: readonly ExistingNodeExecution[];
  readonly latestTaskRuns: readonly ExistingTaskRun[];
  readonly ownerId: string;
  readonly workflowId: string;
  readonly estimatedCreditCostByNodeId?: WorkflowRuntimeEstimatedCreditCostByNodeId;
  readonly plannedItemCountByNodeId?: Readonly<Record<string, number>>;
};

export type PlannedNodeExecution = {
  readonly id: string;
  readonly nodeId: string;
  readonly ownerId: string;
  readonly workflowId: string;
};

export type ReusedNodeExecution = {
  readonly id: string;
  readonly nodeId: string;
};

export type PlannedTaskRun = {
  readonly id: string;
  readonly nodeExecutionId: string;
  readonly nodeId: string;
  readonly targetNodeConfig: WorkflowDefinitionDocumentNode;
  readonly itemIndex: number;
  readonly attempt: number;
  readonly estimatedCreditCost: number;
  readonly status: Extract<TaskRunStatus, "QUEUED" | "WAITING_UPSTREAM">;
};

export type PlannedTaskDependency = {
  readonly childTaskRunId: string;
  readonly childNodeExecutionId: string;
  readonly childNodeId: string;
  readonly parentNodeExecutionId: string;
  readonly parentNodeId: string;
  readonly parentItemIndex: number;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
  readonly targetNodeId: string;
};

export type WorkflowRunPlan = {
  readonly workflowDefinition: WorkflowDefinitionGraphDocument;
  readonly nodeExecutionsToCreate: readonly PlannedNodeExecution[];
  readonly nodeExecutionsToReuse: readonly ReusedNodeExecution[];
  readonly taskRunsToCreate: readonly PlannedTaskRun[];
  readonly taskDependenciesToCreate: readonly PlannedTaskDependency[];
};

export type WorkflowRunPlannerError = {
  readonly _tag: "WorkflowRunPlannerError";
  readonly message: string;
};

export type WorkflowRunPlannerResult =
  | { readonly ok: true; readonly value: WorkflowRunPlan }
  | { readonly ok: false; readonly error: WorkflowRunPlannerError };

function plannerError(message: string): WorkflowRunPlannerResult {
  return { error: { _tag: "WorkflowRunPlannerError", message }, ok: false };
}

function estimatedCreditCost(nodeId: string, input: WorkflowRunPlannerInput) {
  return input.estimatedCreditCostByNodeId?.[nodeId] ?? 0;
}

function taskRunSlotKey(input: {
  readonly nodeExecutionId: string;
  readonly itemIndex: number;
}) {
  return `${input.nodeExecutionId}:${input.itemIndex}`;
}

function isProviderBackedNode(
  node: WorkflowDefinitionDocumentNode | undefined,
) {
  return Boolean(node && isGeneratorNodeKind(node.kind));
}

function addOrdered(
  target: string[],
  seen: Set<string>,
  nodeIds: readonly string[],
) {
  for (const nodeId of nodeIds) {
    if (!seen.has(nodeId)) {
      seen.add(nodeId);
      target.push(nodeId);
    }
  }
}

export function planWorkflowRun(
  input: WorkflowRunPlannerInput,
): WorkflowRunPlannerResult {
  const blueprint = parseWorkflowBlueprint(input.document);
  if (!blueprint.ok) {
    return plannerError(blueprint.error.message);
  }
  const targetNodeConfigByNodeId = new Map(
    toWorkflowDefinitionGraphDocument(input.document).nodes.map((node) => [
      node.id,
      node,
    ]),
  );
  const workflowDefinition = toWorkflowDefinitionGraphDocument(input.document);
  const latestNodeExecutionByNodeId = new Map(
    input.latestNodeExecutions.map((execution) => [
      execution.nodeId,
      execution,
    ]),
  );
  const nodeExecutionById = new Map(
    input.latestNodeExecutions.map((execution) => [execution.id, execution]),
  );
  const regenerationNodeExecution =
    input.command.type === "regenerate-item"
      ? nodeExecutionById.get(input.command.nodeExecutionId)
      : undefined;
  if (input.command.type === "regenerate-item" && !regenerationNodeExecution) {
    return plannerError(
      `Cannot regenerate items for missing Node Execution ${input.command.nodeExecutionId}.`,
    );
  }
  const schedulingTargetNodeIds =
    input.command.type === "run-target"
      ? input.command.targetNodeIds
      : input.command.type === "rerun-node"
        ? [input.command.nodeId]
        : regenerationNodeExecution
          ? [regenerationNodeExecution.nodeId]
          : [];
  const taskSchedulingPlan = (() => {
    try {
      return WorkflowExecutionPlanner.forTaskScheduling({
        document: input.document,
        targetNodeIds: schedulingTargetNodeIds,
      });
    } catch (cause) {
      return cause instanceof Error
        ? cause.message
        : "Workflow planning failed.";
    }
  })();
  if (typeof taskSchedulingPlan === "string") {
    return plannerError(taskSchedulingPlan);
  }
  const latestTaskRunBySlot = new Map<string, ExistingTaskRun>();

  for (const taskRun of input.latestTaskRuns) {
    const key = taskRunSlotKey(taskRun);
    const existing = latestTaskRunBySlot.get(key);
    if (!existing || taskRun.attempt > existing.attempt) {
      latestTaskRunBySlot.set(key, taskRun);
    }
  }

  let nextNodeExecutionId = 1;
  let nextTaskRunId = 1;
  const createNodeExecutionId =
    input.createNodeExecutionId ??
    (() => `planned-node-execution-${nextNodeExecutionId++}`);
  const createTaskRunId =
    input.createTaskRunId ?? (() => `planned-task-run-${nextTaskRunId++}`);
  const nodeExecutionsToCreate: PlannedNodeExecution[] = [];
  const nodeExecutionsToReuse: ReusedNodeExecution[] = [];
  const taskRunsToCreate: PlannedTaskRun[] = [];
  const taskDependenciesToCreate: PlannedTaskDependency[] = [];
  const executionIdByNodeId = new Map<string, string>();
  const plannedTaskRunBySlot = new Map<string, PlannedTaskRun>();

  const latestTaskRun = (nodeExecutionId: string, itemIndex: number) =>
    latestTaskRunBySlot.get(taskRunSlotKey({ itemIndex, nodeExecutionId }));

  const plannedItemIndexesForNode = (nodeId: string) => {
    const count =
      input.plannedItemCountByNodeId?.[nodeId] ??
      taskSchedulingPlan.getOutputCount(nodeId);
    return Array.from({ length: Math.max(1, count) }, (_, index) => index);
  };
  const getPlannedOutputCount = (
    nodeId: string,
    sourceHandleId?: string | null,
  ) =>
    input.plannedItemCountByNodeId?.[nodeId] ??
    taskSchedulingPlan.getOutputCount(nodeId, sourceHandleId);

  const latestNodeExecutionHasActiveTaskRuns = (nodeId: string) => {
    const execution = latestNodeExecutionByNodeId.get(nodeId);
    return Boolean(
      execution &&
        input.latestTaskRuns.some(
          (taskRun) =>
            taskRun.nodeExecutionId === execution.id &&
            isActiveTaskRunStatus(taskRun.status),
        ),
    );
  };

  const ensureNodeExecution = (nodeId: string) => {
    const existingId = executionIdByNodeId.get(nodeId);
    if (existingId) {
      return existingId;
    }

    const latest = latestNodeExecutionByNodeId.get(nodeId);
    if (latest) {
      executionIdByNodeId.set(nodeId, latest.id);
      nodeExecutionsToReuse.push({ id: latest.id, nodeId });
      return latest.id;
    }

    const id = createNodeExecutionId();
    executionIdByNodeId.set(nodeId, id);
    nodeExecutionsToCreate.push({
      id,
      nodeId,
      ownerId: input.ownerId,
      workflowId: input.workflowId,
    });
    return id;
  };

  const createNodeExecution = (nodeId: string) => {
    const id = createNodeExecutionId();
    executionIdByNodeId.set(nodeId, id);
    nodeExecutionsToCreate.push({
      id,
      nodeId,
      ownerId: input.ownerId,
      workflowId: input.workflowId,
    });
    return id;
  };

  const ensureUpstreamProviderNodeExecutions = (nodeId: string) => {
    const upstream = blueprint.value.getUpstreamClosureNodeIds(nodeId);
    if (!upstream.ok) {
      return false;
    }
    for (const upstreamNodeId of upstream.value) {
      if (isProviderBackedNode(targetNodeConfigByNodeId.get(upstreamNodeId))) {
        ensureNodeExecution(upstreamNodeId);
      }
    }
    return true;
  };

  const parentDependencyAddresses = (nodeId: string, itemIndex: number) =>
    collectProviderDependencyAddresses({
      document: input.document,
      getOutputCount: getPlannedOutputCount,
      itemIndex,
      targetNodeId: nodeId,
    });

  const parentsSatisfied = (
    dependencies: readonly ProviderDependencyAddress[],
  ) => {
    if (!dependencies.length) {
      return true;
    }

    return dependencies.every((dependency) => {
      const parentNodeExecutionId = executionIdByNodeId.get(
        dependency.parentNodeId,
      );
      if (!parentNodeExecutionId) {
        return false;
      }

      if (
        plannedTaskRunBySlot.has(
          taskRunSlotKey({
            itemIndex: dependency.parentItemIndex,
            nodeExecutionId: parentNodeExecutionId,
          }),
        )
      ) {
        return false;
      }

      const parentTaskRun = latestTaskRun(
        parentNodeExecutionId,
        dependency.parentItemIndex,
      );
      return parentTaskRun
        ? isTaskRunDependencySatisfiedStatus(parentTaskRun.status)
        : false;
    });
  };

  const createTaskDependencies = (
    taskRun: PlannedTaskRun,
    dependencyAddresses: readonly ProviderDependencyAddress[],
  ) => {
    for (const address of dependencyAddresses) {
      const parentNodeExecutionId = executionIdByNodeId.get(
        address.parentNodeId,
      );
      if (!parentNodeExecutionId) {
        return false;
      }

      taskDependenciesToCreate.push({
        childNodeExecutionId: taskRun.nodeExecutionId,
        childNodeId: taskRun.nodeId,
        childTaskRunId: taskRun.id,
        parentItemIndex: address.parentItemIndex,
        parentNodeExecutionId,
        parentNodeId: address.parentNodeId,
        sourceHandle: address.sourceHandle,
        targetHandle: address.targetHandle,
        targetNodeId: address.targetNodeId,
      });
    }

    return true;
  };

  const createTaskRun = (inputTaskRun: {
    readonly nodeId: string;
    readonly nodeExecutionId: string;
    readonly itemIndex: number;
    readonly attempt: number;
  }) => {
    const targetNodeConfig = targetNodeConfigByNodeId.get(inputTaskRun.nodeId);
    if (!targetNodeConfig) {
      return false;
    }
    if (!isProviderBackedNode(targetNodeConfig)) {
      return false;
    }
    const dependencyAddresses = parentDependencyAddresses(
      inputTaskRun.nodeId,
      inputTaskRun.itemIndex,
    );

    const taskRun: PlannedTaskRun = {
      ...inputTaskRun,
      estimatedCreditCost: estimatedCreditCost(inputTaskRun.nodeId, input),
      id: createTaskRunId(),
      status: parentsSatisfied(dependencyAddresses)
        ? "QUEUED"
        : "WAITING_UPSTREAM",
      targetNodeConfig,
    };
    taskRunsToCreate.push(taskRun);
    plannedTaskRunBySlot.set(taskRunSlotKey(taskRun), taskRun);
    return createTaskDependencies(taskRun, dependencyAddresses);
  };

  const planTaskRunIfNeeded = (params: {
    readonly nodeId: string;
    readonly nodeExecutionId: string;
    readonly itemIndex: number;
  }) => {
    const latest = latestTaskRun(params.nodeExecutionId, params.itemIndex);
    if (!latest) {
      return createTaskRun({ ...params, attempt: 0 });
    }

    return isRecoverableByDownstreamPlanningStatus(latest.status)
      ? createTaskRun({ ...params, attempt: latest.attempt + 1 })
      : true;
  };

  if (input.command.type === "run-target") {
    for (const targetNodeId of input.command.targetNodeIds) {
      if (latestNodeExecutionHasActiveTaskRuns(targetNodeId)) {
        return plannerError(
          `Cannot run target ${targetNodeId} because its latest Node Execution has active Task Runs.`,
        );
      }
    }

    const orderedNodeIds: string[] = [];
    const seenNodeIds = new Set<string>();
    for (const targetNodeId of input.command.targetNodeIds) {
      const upstream = blueprint.value.getUpstreamClosureNodeIds(targetNodeId);
      if (!upstream.ok) {
        return plannerError(upstream.error.message);
      }
      addOrdered(
        orderedNodeIds,
        seenNodeIds,
        [...upstream.value, targetNodeId].filter((nodeId) =>
          isProviderBackedNode(targetNodeConfigByNodeId.get(nodeId)),
        ),
      );
    }

    const targetNodeIds = new Set(input.command.targetNodeIds);
    for (const nodeId of orderedNodeIds) {
      const nodeExecutionId = targetNodeIds.has(nodeId)
        ? createNodeExecution(nodeId)
        : ensureNodeExecution(nodeId);
      for (const itemIndex of plannedItemIndexesForNode(nodeId)) {
        if (!planTaskRunIfNeeded({ itemIndex, nodeExecutionId, nodeId })) {
          return plannerError(`Missing dependency information for ${nodeId}.`);
        }
      }
    }

    return {
      ok: true,
      value: {
        workflowDefinition,
        nodeExecutionsToCreate,
        nodeExecutionsToReuse,
        taskDependenciesToCreate,
        taskRunsToCreate,
      },
    };
  }

  if (input.command.type === "rerun-node") {
    if (latestNodeExecutionHasActiveTaskRuns(input.command.nodeId)) {
      return plannerError(
        `Cannot rerun node ${input.command.nodeId} because its latest Node Execution has active Task Runs.`,
      );
    }

    const nodeExecutionId = createNodeExecution(input.command.nodeId);
    if (!ensureUpstreamProviderNodeExecutions(input.command.nodeId)) {
      return plannerError(
        `Missing dependency information for ${input.command.nodeId}.`,
      );
    }
    for (const itemIndex of plannedItemIndexesForNode(input.command.nodeId)) {
      if (
        !createTaskRun({
          attempt: 0,
          itemIndex,
          nodeExecutionId,
          nodeId: input.command.nodeId,
        })
      ) {
        return plannerError(
          `Missing dependency information for ${input.command.nodeId}.`,
        );
      }
    }

    return {
      ok: true,
      value: {
        workflowDefinition,
        nodeExecutionsToCreate,
        nodeExecutionsToReuse,
        taskDependenciesToCreate,
        taskRunsToCreate,
      },
    };
  }

  const nodeExecution = nodeExecutionById.get(input.command.nodeExecutionId);
  if (!nodeExecution) {
    return plannerError(
      `Cannot regenerate items for missing Node Execution ${input.command.nodeExecutionId}.`,
    );
  }

  for (const itemIndex of input.command.itemIndexes) {
    const latest = latestTaskRun(input.command.nodeExecutionId, itemIndex);
    if (latest && isActiveTaskRunStatus(latest.status)) {
      return plannerError(
        `Cannot regenerate item ${itemIndex} for Node Execution ${input.command.nodeExecutionId} because the latest Attempt is active.`,
      );
    }
  }

  nodeExecutionsToReuse.push({
    id: nodeExecution.id,
    nodeId: nodeExecution.nodeId,
  });
  executionIdByNodeId.set(nodeExecution.nodeId, nodeExecution.id);
  if (!ensureUpstreamProviderNodeExecutions(nodeExecution.nodeId)) {
    return plannerError(
      `Missing dependency information for ${nodeExecution.nodeId}.`,
    );
  }

  for (const itemIndex of input.command.itemIndexes) {
    const latest = latestTaskRun(input.command.nodeExecutionId, itemIndex);
    if (
      !createTaskRun({
        attempt: latest ? latest.attempt + 1 : 0,
        itemIndex,
        nodeExecutionId: input.command.nodeExecutionId,
        nodeId: nodeExecution.nodeId,
      })
    ) {
      return plannerError(
        `Missing dependency information for ${nodeExecution.nodeId}.`,
      );
    }
  }

  return {
    ok: true,
    value: {
      workflowDefinition,
      nodeExecutionsToCreate,
      nodeExecutionsToReuse,
      taskDependenciesToCreate,
      taskRunsToCreate,
    },
  };
}

function collectProviderDependencyAddresses(input: {
  readonly document: WorkflowDocument;
  readonly getOutputCount: (
    nodeId: string,
    sourceHandleId?: string | null,
  ) => number;
  readonly itemIndex: number;
  readonly targetNodeId: string;
}): readonly ProviderDependencyAddress[] {
  const incomingByTarget = buildIncomingByTarget(input.document.edges);
  const nodeById = new Map(input.document.nodes.map((node) => [node.id, node]));
  const dependencies: ProviderDependencyAddress[] = [];

  const collect = (params: {
    readonly nodeId: string;
    readonly itemIndex: number;
    readonly sourceHandle?: string | null;
    readonly targetHandle?: string | null;
    readonly targetNodeId: string;
    readonly path: ReadonlySet<string>;
  }) => {
    if (params.path.has(params.nodeId)) {
      return;
    }
    const node = nodeById.get(params.nodeId);
    if (!node) {
      return;
    }
    const nextPath = new Set(params.path);
    nextPath.add(params.nodeId);

    switch (node.kind) {
      case "imageGenerator":
      case "videoGenerator":
      case "llmGenerator": {
        const outputCount = input.getOutputCount(node.id, params.sourceHandle);
        dependencies.push({
          parentItemIndex: outputCount === 1 ? 0 : params.itemIndex,
          parentNodeId: node.id,
          sourceHandle: params.sourceHandle ?? null,
          targetHandle: params.targetHandle ?? null,
          targetNodeId: params.targetNodeId,
        });
        return;
      }
      case "prompt":
        for (const key of getPromptNodeReferencedVariableKeys(node)) {
          for (const edge of getIncomingEdgesForHandle(
            incomingByTarget,
            node.id,
            key,
          )) {
            collect({
              ...params,
              nodeId: edge.source,
              path: nextPath,
              sourceHandle: edge.sourceHandle,
            });
          }
        }
        return;
      case "outputReorder": {
        const edge = getIncomingEdgesForHandle(
          incomingByTarget,
          node.id,
          OUTPUT_REORDER_INPUT_HANDLE_ID,
        )[0];
        if (!edge) {
          return;
        }
        const outputCount = input.getOutputCount(
          edge.source,
          edge.sourceHandle,
        );
        const permutation = resolveOutputPermutation({
          mode: node.mode,
          order: node.order,
          outputCount,
          shift: node.shift,
        });
        collect({
          ...params,
          itemIndex:
            outputCount === 1
              ? 0
              : (permutation[params.itemIndex] ?? params.itemIndex),
          nodeId: edge.source,
          path: nextPath,
          sourceHandle: edge.sourceHandle,
        });
        return;
      }
      case "asset":
      case "list":
        return;
    }
  };

  for (const edge of incomingByTarget.get(input.targetNodeId) ?? []) {
    collect({
      itemIndex: input.itemIndex,
      nodeId: edge.source,
      path: new Set(),
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      targetNodeId: edge.target,
    });
  }

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
