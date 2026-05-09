import type { ProviderDependencyAddress } from "~/features/runtime/domain/provider-dependency-address";
import {
  isActiveTaskStatus,
  isRecoverableByDownstreamPlanningStatus,
  isTaskDependencySatisfiedStatus,
  type TaskStatus,
} from "~/features/runtime/domain/task-state";
import type { TaskInputSnapshot } from "~/features/runtime/execution/task-input-snapshot";
import {
  materializeTaskInput,
  materializeWorkflowRunTaskFacts,
} from "~/features/runtime/materialization/task-input-materialization";
import { parseWorkflowBlueprint } from "~/features/workflow/blueprint/parser";
import {
  toWorkflowDefinitionGraphDocument,
  type WorkflowDefinitionDocumentNode,
  type WorkflowDefinitionGraphDocument,
  type WorkflowDocument,
} from "~/features/workflow/document";
import { WorkflowValidationError } from "~/features/workflow/errors";
import { getRuntimeTaskCreditCostByNodeId } from "~/features/workflow/server/pricing-catalog";
import { isGeneratorNodeKind } from "~/features/workflow/types";

export type WorkflowRunPlannerCommand =
  | { readonly type: "run-node"; readonly nodeId: string }
  | {
      readonly type: "run-task";
      readonly nodeRunId: string;
      readonly branchIndex: number;
    };

export type ExistingNodeRun = {
  readonly id: string;
  readonly nodeId: string;
};

export type ExistingTask = {
  readonly id: string;
  readonly creditCost?: number;
  readonly nodeRunId: string;
  readonly nodeId?: string;
  readonly branchIndex: number;
  readonly status: TaskStatus;
};

export type WorkflowRunPlannerInput = {
  readonly command: WorkflowRunPlannerCommand;
  readonly createNodeRunId?: () => string;
  readonly createTaskId?: () => string;
  readonly document: WorkflowDocument;
  readonly documentRevision?: number | null;
  readonly latestNodeRuns: readonly ExistingNodeRun[];
  readonly latestTasks: readonly ExistingTask[];
  readonly ownerId: string;
  readonly workflowId: string;
  readonly plannedItemCountByNodeId?: Readonly<Record<string, number>>;
};

export type PlannedNodeRun = {
  readonly id: string;
  readonly nodeId: string;
  readonly ownerId: string;
  readonly workflowId: string;
};

export type ReusedNodeRun = {
  readonly id: string;
  readonly nodeId: string;
};

export type PlannedTask = {
  readonly id: string;
  readonly nodeRunId: string;
  readonly nodeId: string;
  readonly targetNodeConfig: WorkflowDefinitionDocumentNode;
  readonly branchIndex: number;
  readonly creditCost: number;
  readonly failureReason?: "EXECUTION_FAILED";
  readonly inputSnapshot?: TaskInputSnapshot;
  readonly status: Extract<
    TaskStatus,
    "FAILED" | "QUEUED" | "WAITING_UPSTREAM"
  >;
};

export type PlannedTaskDependency = {
  readonly childTaskId: string;
  readonly childNodeRunId: string;
  readonly childNodeId: string;
  readonly parentNodeRunId: string;
  readonly parentNodeId: string;
  readonly parentBranchIndex: number;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
  readonly targetNodeId: string;
};

export type RunCostPreviewItem = {
  readonly creditCost: number;
  readonly debitTiming:
    | "queued-immediately"
    | "waiting-upstream"
    | "excluded-existing"
    | "failed-before-queue";
  readonly branchIndex: number;
  readonly nodeRunId: string;
  readonly nodeId: string;
  readonly role: "target" | "upstream";
  readonly source: "planned" | "stored";
  readonly status: TaskStatus;
  readonly taskId: string;
};

export type RunCostPreview = {
  readonly items: readonly RunCostPreviewItem[];
  readonly queuedImmediate: {
    readonly items: readonly RunCostPreviewItem[];
    readonly totalCreditCost: number;
  };
  readonly waitingUpstream: {
    readonly items: readonly RunCostPreviewItem[];
    readonly totalCreditCost: number;
  };
  readonly excludedExisting: {
    readonly items: readonly RunCostPreviewItem[];
    readonly totalCreditCost: number;
  };
  readonly failedBeforeQueue: {
    readonly items: readonly RunCostPreviewItem[];
    readonly totalCreditCost: number;
  };
  readonly newCostTotal: number;
  readonly immediateDebitTotal: number;
};

export type WorkflowRunPlan = {
  readonly workflowDefinition: WorkflowDefinitionGraphDocument;
  readonly nodeRunsToCreate: readonly PlannedNodeRun[];
  readonly nodeRunsToReuse: readonly ReusedNodeRun[];
  readonly runCostPreview: RunCostPreview;
  readonly tasksToCreate: readonly PlannedTask[];
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

function taskKey(input: {
  readonly nodeRunId: string;
  readonly branchIndex: number;
}) {
  return `${input.nodeRunId}:${input.branchIndex}`;
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
  const creditCostByNodeIdResult = pricingCatalogCreditCosts(input.document);
  if (!creditCostByNodeIdResult.ok) {
    return plannerError(creditCostByNodeIdResult.error.message);
  }
  const creditCostByNodeId = creditCostByNodeIdResult.value;
  const latestNodeRunByNodeId = new Map(
    input.latestNodeRuns.map((execution) => [execution.nodeId, execution]),
  );
  const nodeRunById = new Map(
    input.latestNodeRuns.map((execution) => [execution.id, execution]),
  );
  const taskNodeRun =
    input.command.type === "run-task"
      ? nodeRunById.get(input.command.nodeRunId)
      : undefined;
  if (input.command.type === "run-task") {
    if (
      !Number.isInteger(input.command.branchIndex) ||
      input.command.branchIndex < 0
    ) {
      return plannerError(
        `Cannot run invalid Branch Index ${input.command.branchIndex} for Node Run ${input.command.nodeRunId}.`,
      );
    }
  }
  if (input.command.type === "run-task" && !taskNodeRun) {
    return plannerError(
      `Cannot run Task slot for missing Node Run ${input.command.nodeRunId}.`,
    );
  }
  const schedulingTargetNodeIds =
    input.command.type === "run-node"
      ? [input.command.nodeId]
      : taskNodeRun
        ? [taskNodeRun.nodeId]
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
      taskKey({
        branchIndex: fact.branchIndex,
        nodeRunId: fact.nodeId,
      }),
      fact,
    ]),
  );
  const latestTaskBySlot = new Map<string, ExistingTask>();

  for (const task of input.latestTasks) {
    const key = taskKey(task);
    const existing = latestTaskBySlot.get(key);
    if (!existing) {
      latestTaskBySlot.set(key, task);
    }
  }

  let nextNodeRunId = 1;
  let nextTaskId = 1;
  const createNodeRunId =
    input.createNodeRunId ??
    (() => `planned-node-execution-${nextNodeRunId++}`);
  const createTaskId =
    input.createTaskId ?? (() => `planned-task-run-${nextTaskId++}`);
  const nodeRunsToCreate: PlannedNodeRun[] = [];
  const nodeRunsToReuse: ReusedNodeRun[] = [];
  const tasksToCreate: PlannedTask[] = [];
  const taskDependenciesToCreate: PlannedTaskDependency[] = [];
  const storedPreviewItems: RunCostPreviewItem[] = [];
  const storedPreviewItemKeys = new Set<string>();
  const executionIdByNodeId = new Map<string, string>();
  const plannedTaskBySlot = new Map<string, PlannedTask>();
  const targetNodeId = schedulingTargetNodeIds[0] ?? null;

  const latestTask = (nodeRunId: string, branchIndex: number) =>
    latestTaskBySlot.get(taskKey({ branchIndex, nodeRunId }));

  const plannedBranchIndexesForNode = (nodeId: string) => {
    const count = materializationFacts.value.itemCountByNodeId[nodeId] ?? 1;
    return Array.from({ length: Math.max(1, count) }, (_, index) => index);
  };

  const latestNodeRunHasActiveTasks = (nodeId: string) => {
    const execution = latestNodeRunByNodeId.get(nodeId);
    return Boolean(
      execution &&
        input.latestTasks.some(
          (task) =>
            task.nodeRunId === execution.id && isActiveTaskStatus(task.status),
        ),
    );
  };

  const ensureNodeRun = (nodeId: string) => {
    const existingId = executionIdByNodeId.get(nodeId);
    if (existingId) {
      return existingId;
    }

    const latest = latestNodeRunByNodeId.get(nodeId);
    if (latest) {
      executionIdByNodeId.set(nodeId, latest.id);
      nodeRunsToReuse.push({ id: latest.id, nodeId });
      return latest.id;
    }

    const id = createNodeRunId();
    executionIdByNodeId.set(nodeId, id);
    nodeRunsToCreate.push({
      id,
      nodeId,
      ownerId: input.ownerId,
      workflowId: input.workflowId,
    });
    return id;
  };

  const createNodeRun = (nodeId: string) => {
    const id = createNodeRunId();
    executionIdByNodeId.set(nodeId, id);
    nodeRunsToCreate.push({
      id,
      nodeId,
      ownerId: input.ownerId,
      workflowId: input.workflowId,
    });
    return id;
  };

  const parentDependencyAddresses = (nodeId: string, branchIndex: number) =>
    materializedTaskFactsBySlot.get(taskKey({ branchIndex, nodeRunId: nodeId }))
      ?.dependencyAddresses ?? [];
  const materializationTaskFact = (nodeId: string, branchIndex: number) =>
    materializedTaskFactsBySlot.get(
      taskKey({ branchIndex, nodeRunId: nodeId }),
    );

  const parentsSatisfied = (
    dependencies: readonly ProviderDependencyAddress[],
  ) => {
    if (!dependencies.length) {
      return true;
    }

    return dependencies.every((dependency) => {
      const parentNodeRunId = executionIdByNodeId.get(dependency.parentNodeId);
      if (!parentNodeRunId) {
        return false;
      }

      if (
        plannedTaskBySlot.has(
          taskKey({
            branchIndex: dependency.parentBranchIndex,
            nodeRunId: parentNodeRunId,
          }),
        )
      ) {
        return false;
      }

      const parentTask = latestTask(
        parentNodeRunId,
        dependency.parentBranchIndex,
      );
      return parentTask
        ? isTaskDependencySatisfiedStatus(parentTask.status)
        : false;
    });
  };

  const createTaskDependencies = (
    task: PlannedTask,
    dependencyAddresses: readonly ProviderDependencyAddress[],
  ) => {
    for (const address of dependencyAddresses) {
      const parentNodeRunId = executionIdByNodeId.get(address.parentNodeId);
      if (!parentNodeRunId) {
        return false;
      }

      taskDependenciesToCreate.push({
        childNodeRunId: task.nodeRunId,
        childNodeId: task.nodeId,
        childTaskId: task.id,
        parentBranchIndex: address.parentBranchIndex,
        parentNodeRunId,
        parentNodeId: address.parentNodeId,
        sourceHandle: address.sourceHandle,
        targetHandle: address.targetHandle,
        targetNodeId: address.targetNodeId,
      });
    }

    return true;
  };

  const createTask = (inputTask: {
    readonly nodeId: string;
    readonly nodeRunId: string;
    readonly branchIndex: number;
  }) => {
    const targetNodeConfig = targetNodeConfigByNodeId.get(inputTask.nodeId);
    if (!targetNodeConfig) {
      return false;
    }
    if (!isProviderBackedNode(targetNodeConfig)) {
      return false;
    }
    const taskId = createTaskId();
    const dependencyAddresses = parentDependencyAddresses(
      inputTask.nodeId,
      inputTask.branchIndex,
    );
    const taskFact = materializationTaskFact(
      inputTask.nodeId,
      inputTask.branchIndex,
    );
    const status = parentsSatisfied(dependencyAddresses)
      ? "QUEUED"
      : "WAITING_UPSTREAM";
    const materialization = materializeTaskInput({
      document: input.document,
      documentRevision: input.documentRevision ?? null,
      branchIndex: inputTask.branchIndex,
      materializedInputFacts: taskFact?.providerInputFacts,
      nodeRunId: inputTask.nodeRunId,
      nodeId: inputTask.nodeId,
      taskId,
    });
    const task: PlannedTask = {
      ...inputTask,
      creditCost: creditCostByNodeId[inputTask.nodeId] ?? 0,
      ...(taskFact?.error
        ? { failureReason: "EXECUTION_FAILED" as const }
        : materialization?.ok
          ? { inputSnapshot: materialization.value }
          : materialization
            ? { failureReason: "EXECUTION_FAILED" as const }
            : {}),
      id: taskId,
      status:
        taskFact?.error || (materialization && !materialization.ok)
          ? "FAILED"
          : status,
      targetNodeConfig,
    };
    tasksToCreate.push(task);
    plannedTaskBySlot.set(taskKey(task), task);
    return createTaskDependencies(task, dependencyAddresses);
  };

  const planTaskIfNeeded = (params: {
    readonly nodeId: string;
    readonly nodeRunId: string;
    readonly branchIndex: number;
  }) => {
    if (plannedTaskBySlot.has(taskKey(params))) {
      return true;
    }
    const latest = latestTask(params.nodeRunId, params.branchIndex);
    if (!latest) {
      return createTask(params);
    }

    if (isRecoverableByDownstreamPlanningStatus(latest.status)) {
      return createTask(params);
    }

    const key = taskKey(params);
    if (!storedPreviewItemKeys.has(key)) {
      storedPreviewItemKeys.add(key);
      const nodeId = latest.nodeId ?? params.nodeId;
      storedPreviewItems.push({
        creditCost: latest.creditCost ?? 0,
        debitTiming: "excluded-existing",
        branchIndex: latest.branchIndex,
        nodeRunId: latest.nodeRunId,
        nodeId,
        role: nodeId === targetNodeId ? "target" : "upstream",
        source: "stored",
        status: latest.status,
        taskId: latest.id,
      });
    }

    return true;
  };

  const ensureProviderTask = (nodeId: string, branchIndex: number): boolean => {
    const nodeRunId = ensureNodeRun(nodeId);
    for (const dependency of parentDependencyAddresses(nodeId, branchIndex)) {
      if (
        isProviderBackedNode(
          targetNodeConfigByNodeId.get(dependency.parentNodeId),
        ) &&
        !ensureProviderTask(
          dependency.parentNodeId,
          dependency.parentBranchIndex,
        )
      ) {
        return false;
      }
    }
    return planTaskIfNeeded({ branchIndex, nodeRunId, nodeId });
  };

  const ensureUpstreamProviderTasks = (
    nodeId: string,
    branchIndexes: readonly number[],
  ) => {
    for (const branchIndex of branchIndexes) {
      for (const dependency of parentDependencyAddresses(nodeId, branchIndex)) {
        if (
          isProviderBackedNode(
            targetNodeConfigByNodeId.get(dependency.parentNodeId),
          ) &&
          !ensureProviderTask(
            dependency.parentNodeId,
            dependency.parentBranchIndex,
          )
        ) {
          return false;
        }
      }
    }
    return true;
  };

  if (input.command.type === "run-node") {
    if (latestNodeRunHasActiveTasks(input.command.nodeId)) {
      return plannerError(
        `Cannot run node ${input.command.nodeId} because its latest Node Run has active Tasks.`,
      );
    }

    const latestTargetExecution = latestNodeRunByNodeId.get(
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
        const nodeRunId =
          nodeId === input.command.nodeId
            ? createNodeRun(nodeId)
            : ensureNodeRun(nodeId);
        for (const branchIndex of plannedBranchIndexesForNode(nodeId)) {
          if (!planTaskIfNeeded({ branchIndex, nodeRunId, nodeId })) {
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
          nodeRunsToCreate,
          nodeRunsToReuse,
          runCostPreview: buildRunCostPreview({
            storedPreviewItems,
            targetNodeId: input.command.nodeId,
            tasksToCreate,
          }),
          taskDependenciesToCreate,
          tasksToCreate,
        },
      };
    }

    const nodeRunId = createNodeRun(input.command.nodeId);
    const branchIndexes = plannedBranchIndexesForNode(input.command.nodeId);
    if (!ensureUpstreamProviderTasks(input.command.nodeId, branchIndexes)) {
      return plannerError(
        `Missing dependency information for ${input.command.nodeId}.`,
      );
    }
    for (const branchIndex of branchIndexes) {
      if (
        !createTask({
          branchIndex,
          nodeRunId,
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
        nodeRunsToCreate,
        nodeRunsToReuse,
        runCostPreview: buildRunCostPreview({
          storedPreviewItems,
          targetNodeId: input.command.nodeId,
          tasksToCreate,
        }),
        taskDependenciesToCreate,
        tasksToCreate,
      },
    };
  }

  const nodeRun = nodeRunById.get(input.command.nodeRunId);
  if (!nodeRun) {
    return plannerError(
      `Cannot run Task slot for missing Node Run ${input.command.nodeRunId}.`,
    );
  }

  const latest = latestTask(input.command.nodeRunId, input.command.branchIndex);
  if (latest && isActiveTaskStatus(latest.status)) {
    return plannerError(
      `Cannot run Branch Index ${input.command.branchIndex} for Node Run ${input.command.nodeRunId} because the latest Task is active.`,
    );
  }

  nodeRunsToReuse.push({
    id: nodeRun.id,
    nodeId: nodeRun.nodeId,
  });
  executionIdByNodeId.set(nodeRun.nodeId, nodeRun.id);
  if (
    !ensureUpstreamProviderTasks(nodeRun.nodeId, [input.command.branchIndex])
  ) {
    return plannerError(
      `Missing dependency information for ${nodeRun.nodeId}.`,
    );
  }

  if (
    !createTask({
      branchIndex: input.command.branchIndex,
      nodeRunId: input.command.nodeRunId,
      nodeId: nodeRun.nodeId,
    })
  ) {
    return plannerError(
      `Missing dependency information for ${nodeRun.nodeId}.`,
    );
  }

  return {
    ok: true,
    value: {
      workflowDefinition,
      nodeRunsToCreate,
      nodeRunsToReuse,
      runCostPreview: buildRunCostPreview({
        storedPreviewItems,
        targetNodeId: nodeRun.nodeId,
        tasksToCreate,
      }),
      taskDependenciesToCreate,
      tasksToCreate,
    },
  };
}

function buildRunCostPreview(input: {
  readonly storedPreviewItems: readonly RunCostPreviewItem[];
  readonly targetNodeId: string;
  readonly tasksToCreate: readonly PlannedTask[];
}): RunCostPreview {
  const plannedItems = input.tasksToCreate.map(
    (task): RunCostPreviewItem => ({
      creditCost: task.creditCost,
      debitTiming:
        task.status === "QUEUED"
          ? "queued-immediately"
          : task.status === "WAITING_UPSTREAM"
            ? "waiting-upstream"
            : "failed-before-queue",
      branchIndex: task.branchIndex,
      nodeRunId: task.nodeRunId,
      nodeId: task.nodeId,
      role: task.nodeId === input.targetNodeId ? "target" : "upstream",
      source: "planned",
      status: task.status,
      taskId: task.id,
    }),
  );
  const items = [...input.storedPreviewItems, ...plannedItems];
  const queuedImmediate = items.filter(
    (item) => item.debitTiming === "queued-immediately",
  );
  const waitingUpstream = items.filter(
    (item) => item.debitTiming === "waiting-upstream",
  );
  const excludedExisting = items.filter(
    (item) => item.debitTiming === "excluded-existing",
  );
  const failedBeforeQueue = items.filter(
    (item) => item.debitTiming === "failed-before-queue",
  );
  const queuedTotal = totalCreditCost(queuedImmediate);
  const waitingTotal = totalCreditCost(waitingUpstream);

  return {
    excludedExisting: {
      items: excludedExisting,
      totalCreditCost: totalCreditCost(excludedExisting),
    },
    failedBeforeQueue: {
      items: failedBeforeQueue,
      totalCreditCost: totalCreditCost(failedBeforeQueue),
    },
    immediateDebitTotal: queuedTotal,
    items,
    newCostTotal: queuedTotal + waitingTotal,
    queuedImmediate: { items: queuedImmediate, totalCreditCost: queuedTotal },
    waitingUpstream: { items: waitingUpstream, totalCreditCost: waitingTotal },
  };
}

function totalCreditCost(items: readonly RunCostPreviewItem[]) {
  return items.reduce((total, item) => total + item.creditCost, 0);
}

function pricingCatalogCreditCosts(document: WorkflowDocument):
  | {
      readonly ok: true;
      readonly value: ReturnType<typeof getRuntimeTaskCreditCostByNodeId>;
    }
  | { readonly ok: false; readonly error: WorkflowRunPlannerError } {
  try {
    return {
      ok: true,
      value: getRuntimeTaskCreditCostByNodeId({ document }),
    };
  } catch (error) {
    if (error instanceof WorkflowValidationError) {
      return {
        error: { _tag: "WorkflowRunPlannerError", message: error.message },
        ok: false,
      };
    }
    throw error;
  }
}
