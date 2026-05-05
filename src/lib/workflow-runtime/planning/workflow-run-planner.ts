import {
  toWorkflowDefinitionGraphDocument,
  type WorkflowDefinitionDocumentNode,
  type WorkflowDefinitionGraphDocument,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import { parseWorkflowBlueprint } from "~/lib/workflow/runtime/planning/blueprint/parser";
import { isGeneratorNodeKind } from "~/lib/workflow/types";
import type { ProviderDependencyAddress } from "~/lib/workflow-runtime/domain/provider-dependency-address";
import {
  isActiveTaskRunStatus,
  isRecoverableByDownstreamPlanningStatus,
  isTaskRunDependencySatisfiedStatus,
  type TaskRunStatus,
} from "~/lib/workflow-runtime/domain/task-run-state";
import type { TaskRunInputSnapshot } from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
import {
  materializeTaskRunInput,
  materializeWorkflowRunTaskFacts,
} from "~/lib/workflow-runtime/materialization/task-run-input-materialization";

type WorkflowRuntimeEstimatedCreditCostByNodeId = Readonly<
  Record<string, number>
>;

export type WorkflowRunPlannerCommand =
  | { readonly type: "run-node"; readonly nodeId: string }
  | {
      readonly type: "run-task-slot";
      readonly nodeExecutionId: string;
      readonly itemIndex: number;
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
  readonly documentRevision?: number | null;
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
  readonly failureReason?: "EXECUTION_FAILED";
  readonly inputSnapshot?: TaskRunInputSnapshot;
  readonly status: Extract<
    TaskRunStatus,
    "FAILED" | "QUEUED" | "WAITING_UPSTREAM"
  >;
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
  const taskSlotNodeExecution =
    input.command.type === "run-task-slot"
      ? nodeExecutionById.get(input.command.nodeExecutionId)
      : undefined;
  if (input.command.type === "run-task-slot") {
    if (
      !Number.isInteger(input.command.itemIndex) ||
      input.command.itemIndex < 0
    ) {
      return plannerError(
        `Cannot run invalid Item Index ${input.command.itemIndex} for Node Execution ${input.command.nodeExecutionId}.`,
      );
    }
  }
  if (input.command.type === "run-task-slot" && !taskSlotNodeExecution) {
    return plannerError(
      `Cannot run Task Run slot for missing Node Execution ${input.command.nodeExecutionId}.`,
    );
  }
  const schedulingTargetNodeIds =
    input.command.type === "run-node"
      ? [input.command.nodeId]
      : taskSlotNodeExecution
        ? [taskSlotNodeExecution.nodeId]
        : [];
  const materializationFacts = materializeWorkflowRunTaskFacts({
    document: input.document,
    plannedItemCountByNodeId: input.plannedItemCountByNodeId,
    targetNodeIds: schedulingTargetNodeIds,
  });
  if (!materializationFacts.ok) {
    return plannerError(materializationFacts.error.message);
  }
  const materializedTaskFactsBySlot = new Map(
    materializationFacts.value.taskFacts.map((fact) => [
      taskRunSlotKey({
        itemIndex: fact.itemIndex,
        nodeExecutionId: fact.nodeId,
      }),
      fact,
    ]),
  );
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
    const count = materializationFacts.value.itemCountByNodeId[nodeId] ?? 1;
    return Array.from({ length: Math.max(1, count) }, (_, index) => index);
  };

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

  const parentDependencyAddresses = (nodeId: string, itemIndex: number) =>
    materializedTaskFactsBySlot.get(
      taskRunSlotKey({ itemIndex, nodeExecutionId: nodeId }),
    )?.dependencyAddresses ?? [];
  const materializationTaskFact = (nodeId: string, itemIndex: number) =>
    materializedTaskFactsBySlot.get(
      taskRunSlotKey({ itemIndex, nodeExecutionId: nodeId }),
    );

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
    const taskRunId = createTaskRunId();
    const dependencyAddresses = parentDependencyAddresses(
      inputTaskRun.nodeId,
      inputTaskRun.itemIndex,
    );
    const taskFact = materializationTaskFact(
      inputTaskRun.nodeId,
      inputTaskRun.itemIndex,
    );
    const status = parentsSatisfied(dependencyAddresses)
      ? "QUEUED"
      : "WAITING_UPSTREAM";
    const materialization = materializeTaskRunInput({
      attempt: inputTaskRun.attempt,
      document: input.document,
      documentRevision: input.documentRevision ?? null,
      itemIndex: inputTaskRun.itemIndex,
      materializedInputFacts: taskFact?.providerInputFacts,
      nodeExecutionId: inputTaskRun.nodeExecutionId,
      nodeId: inputTaskRun.nodeId,
      taskRunId,
    });
    const taskRun: PlannedTaskRun = {
      ...inputTaskRun,
      estimatedCreditCost: estimatedCreditCost(inputTaskRun.nodeId, input),
      ...(taskFact?.error
        ? { failureReason: "EXECUTION_FAILED" as const }
        : materialization?.ok
          ? { inputSnapshot: materialization.value }
          : materialization
            ? { failureReason: "EXECUTION_FAILED" as const }
            : {}),
      id: taskRunId,
      status:
        taskFact?.error || (materialization && !materialization.ok)
          ? "FAILED"
          : status,
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
    if (plannedTaskRunBySlot.has(taskRunSlotKey(params))) {
      return true;
    }
    const latest = latestTaskRun(params.nodeExecutionId, params.itemIndex);
    if (!latest) {
      return createTaskRun({ ...params, attempt: 0 });
    }

    return isRecoverableByDownstreamPlanningStatus(latest.status)
      ? createTaskRun({ ...params, attempt: latest.attempt + 1 })
      : true;
  };

  const ensureProviderTaskRunSlot = (
    nodeId: string,
    itemIndex: number,
  ): boolean => {
    const nodeExecutionId = ensureNodeExecution(nodeId);
    for (const dependency of parentDependencyAddresses(nodeId, itemIndex)) {
      if (
        isProviderBackedNode(
          targetNodeConfigByNodeId.get(dependency.parentNodeId),
        ) &&
        !ensureProviderTaskRunSlot(
          dependency.parentNodeId,
          dependency.parentItemIndex,
        )
      ) {
        return false;
      }
    }
    return planTaskRunIfNeeded({ itemIndex, nodeExecutionId, nodeId });
  };

  const ensureUpstreamProviderTaskRuns = (
    nodeId: string,
    itemIndexes: readonly number[],
  ) => {
    for (const itemIndex of itemIndexes) {
      for (const dependency of parentDependencyAddresses(nodeId, itemIndex)) {
        if (
          isProviderBackedNode(
            targetNodeConfigByNodeId.get(dependency.parentNodeId),
          ) &&
          !ensureProviderTaskRunSlot(
            dependency.parentNodeId,
            dependency.parentItemIndex,
          )
        ) {
          return false;
        }
      }
    }
    return true;
  };

  if (input.command.type === "run-node") {
    if (latestNodeExecutionHasActiveTaskRuns(input.command.nodeId)) {
      return plannerError(
        `Cannot run node ${input.command.nodeId} because its latest Node Execution has active Task Runs.`,
      );
    }

    const latestTargetExecution = latestNodeExecutionByNodeId.get(
      input.command.nodeId,
    );

    if (!latestTargetExecution) {
      const orderedNodeIds: string[] = [];
      const seenNodeIds = new Set<string>();
      const upstream = blueprint.value.getUpstreamClosureNodeIds(
        input.command.nodeId,
      );
      if (!upstream.ok) {
        return plannerError(upstream.error.message);
      }
      addOrdered(
        orderedNodeIds,
        seenNodeIds,
        [...upstream.value, input.command.nodeId].filter((nodeId) =>
          isProviderBackedNode(targetNodeConfigByNodeId.get(nodeId)),
        ),
      );

      for (const nodeId of orderedNodeIds) {
        const nodeExecutionId =
          nodeId === input.command.nodeId
            ? createNodeExecution(nodeId)
            : ensureNodeExecution(nodeId);
        for (const itemIndex of plannedItemIndexesForNode(nodeId)) {
          if (!planTaskRunIfNeeded({ itemIndex, nodeExecutionId, nodeId })) {
            return plannerError(
              `Missing dependency information for ${nodeId}.`,
            );
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

    const nodeExecutionId = createNodeExecution(input.command.nodeId);
    const itemIndexes = plannedItemIndexesForNode(input.command.nodeId);
    if (!ensureUpstreamProviderTaskRuns(input.command.nodeId, itemIndexes)) {
      return plannerError(
        `Missing dependency information for ${input.command.nodeId}.`,
      );
    }
    for (const itemIndex of itemIndexes) {
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
      `Cannot run Task Run slot for missing Node Execution ${input.command.nodeExecutionId}.`,
    );
  }

  const latest = latestTaskRun(
    input.command.nodeExecutionId,
    input.command.itemIndex,
  );
  if (latest && isActiveTaskRunStatus(latest.status)) {
    return plannerError(
      `Cannot run Item Index ${input.command.itemIndex} for Node Execution ${input.command.nodeExecutionId} because the latest Attempt is active.`,
    );
  }

  nodeExecutionsToReuse.push({
    id: nodeExecution.id,
    nodeId: nodeExecution.nodeId,
  });
  executionIdByNodeId.set(nodeExecution.nodeId, nodeExecution.id);
  if (
    !ensureUpstreamProviderTaskRuns(nodeExecution.nodeId, [
      input.command.itemIndex,
    ])
  ) {
    return plannerError(
      `Missing dependency information for ${nodeExecution.nodeId}.`,
    );
  }

  if (
    !createTaskRun({
      attempt: latest ? latest.attempt + 1 : 0,
      itemIndex: input.command.itemIndex,
      nodeExecutionId: input.command.nodeExecutionId,
      nodeId: nodeExecution.nodeId,
    })
  ) {
    return plannerError(
      `Missing dependency information for ${nodeExecution.nodeId}.`,
    );
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
