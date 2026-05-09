import {
  isTaskDependencySatisfiedStatus,
  isTerminalTaskStatus,
  type TaskFailureReason,
  type TaskStatus,
} from "~/features/runtime/domain/task-state";
import {
  buildExecutionJobId,
  buildTaskStatusEvent,
  type RenderableTaskOutput,
  type TaskStatusEvent,
} from "~/features/runtime/events/task-status-events";
import {
  buildTaskInputSnapshot,
  type ExecutableTaskInputSnapshot,
  type TaskInputSnapshot,
} from "~/features/runtime/execution/task-input-snapshot";
import type { WorkflowDefinitionDocumentNode } from "~/features/workflow/document";
import type { WorkflowAsset } from "~/features/workflow/types";

export type TaskGatekeeperTask = {
  readonly id: string;
  readonly nodeRunId: string;
  readonly nodeId: string;
  readonly branchIndex: number;
  readonly status: TaskStatus;
  readonly creditCost: number;
  readonly targetNodeConfig?: WorkflowDefinitionDocumentNode;
  readonly asset?: WorkflowAsset;
  readonly output?: RenderableTaskOutput;
  readonly failureReason?: TaskFailureReason;
  readonly inputSnapshot?: TaskInputSnapshot;
};

export type TaskGatekeeperDependency = {
  readonly childTaskId: string;
  readonly requiredParentNodeRunId: string;
  readonly requiredParentBranchIndex: number;
  readonly resolvedParentTaskId: string | null;
  readonly requiredParentNodeId: string;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
  readonly targetNodeId: string;
};

export type TaskGatekeeperState = {
  readonly creditBalance: number;
  readonly tasks: readonly TaskGatekeeperTask[];
  readonly dependencies: readonly TaskGatekeeperDependency[];
};

export type TaskExecutionJobDraft = {
  readonly id: string;
  readonly taskId: string;
  readonly inputSnapshot: ExecutableTaskInputSnapshot;
};

export type TaskGatekeeperResult = {
  readonly state: TaskGatekeeperState;
  readonly executionJobs: readonly TaskExecutionJobDraft[];
  readonly taskStatusEvents: readonly TaskStatusEvent[];
};

export type WakeUpTaskChildrenCommand = {
  readonly settledParentTaskId: string;
};

export type RecordDirectTaskFailureCommand = {
  readonly taskId: string;
  readonly failureReason: Exclude<
    TaskFailureReason,
    { readonly type: "UPSTREAM_FAILED" }
  >;
};

export function wakeUpTaskChildren(
  state: TaskGatekeeperState,
  command: WakeUpTaskChildrenCommand,
): TaskGatekeeperResult {
  const parent = findTask(state.tasks, command.settledParentTaskId);
  if (!parent) {
    return emptyResult(state);
  }

  return runGatekeeper(state, [parent]);
}

export function recordDirectTaskFailure(
  state: TaskGatekeeperState,
  command: RecordDirectTaskFailureCommand,
): TaskGatekeeperResult {
  const failedTask = findTask(state.tasks, command.taskId);
  if (!failedTask || isTerminalTaskStatus(failedTask.status)) {
    return emptyResult(state);
  }

  const nextTask = {
    ...failedTask,
    failureReason: command.failureReason,
    status: "FAILED",
  } satisfies TaskGatekeeperTask;
  const nextState = replaceTask(state, nextTask);
  const result = runGatekeeper(nextState, [nextTask]);

  return {
    ...result,
    taskStatusEvents: [buildStatusEvent(nextTask), ...result.taskStatusEvents],
  };
}

function runGatekeeper(
  state: TaskGatekeeperState,
  settledParents: readonly TaskGatekeeperTask[],
): TaskGatekeeperResult {
  let nextState = state;
  const executionJobs: TaskExecutionJobDraft[] = [];
  const taskStatusEvents: TaskStatusEvent[] = [];
  const cascadeQueue = [...settledParents];

  for (let index = 0; index < cascadeQueue.length; index += 1) {
    const settledParent = cascadeQueue[index];
    if (!settledParent) {
      continue;
    }

    for (const child of findWaitingChildren(nextState, settledParent)) {
      const latestRequiredParent = findLatestTaskForSlot(
        nextState.tasks,
        settledParent,
      );
      if (!latestRequiredParent) {
        continue;
      }

      if (isDependencyFailureStatus(latestRequiredParent.status)) {
        const upstreamFailedChild = failTaskFromUpstream(
          child,
          latestRequiredParent.id,
        );
        nextState = replaceTask(nextState, upstreamFailedChild);
        taskStatusEvents.push(buildStatusEvent(upstreamFailedChild));
        cascadeQueue.push(upstreamFailedChild);
        continue;
      }

      const resolvedDependencies = resolveReadyParentDependencies(
        nextState,
        child.id,
      );
      if (!resolvedDependencies) {
        continue;
      }

      const inputSnapshot = buildInputSnapshot(child, resolvedDependencies);
      if (inputSnapshot.providerInput.kind === "non-executable-node") {
        const failedChild = {
          ...child,
          failureReason: {
            message: inputSnapshot.providerInput.message,
            type: "EXECUTION_FAILED",
          },
          inputSnapshot,
          status: "FAILED",
        } satisfies TaskGatekeeperTask;
        nextState = replaceTask(nextState, failedChild);
        taskStatusEvents.push(buildStatusEvent(failedChild));
        cascadeQueue.push(failedChild);
        continue;
      }
      const executableInputSnapshot: ExecutableTaskInputSnapshot = {
        ...inputSnapshot,
        providerInput: inputSnapshot.providerInput,
      };

      const queuedChild = {
        ...child,
        inputSnapshot: executableInputSnapshot,
        status: "QUEUED",
      } satisfies TaskGatekeeperTask;

      nextState = {
        creditBalance: nextState.creditBalance,
        dependencies: nextState.dependencies.map((dependency) => {
          if (dependency.childTaskId !== child.id) {
            return dependency;
          }

          const resolvedDependency = resolvedDependencies.find(
            (candidate) => candidate.dependency === dependency,
          );

          return resolvedDependency
            ? {
                ...dependency,
                resolvedParentTaskId: resolvedDependency.parent.id,
              }
            : dependency;
        }),
        tasks: nextState.tasks.map((task) =>
          task.id === queuedChild.id ? queuedChild : task,
        ),
      };
      executionJobs.push({
        id: buildExecutionJobId({
          taskId: queuedChild.id,
        }),
        inputSnapshot: executableInputSnapshot,
        taskId: queuedChild.id,
      });
      taskStatusEvents.push(buildStatusEvent(queuedChild));
    }
  }

  return { executionJobs, state: nextState, taskStatusEvents };
}

function resolveReadyParentDependencies(
  state: TaskGatekeeperState,
  childTaskId: string,
):
  | readonly {
      readonly dependency: TaskGatekeeperDependency;
      readonly parent: TaskGatekeeperTask;
    }[]
  | null {
  const dependencies = state.dependencies.filter(
    (dependency) => dependency.childTaskId === childTaskId,
  );
  const parents: {
    readonly dependency: TaskGatekeeperDependency;
    readonly parent: TaskGatekeeperTask;
  }[] = [];

  for (const dependency of dependencies) {
    const latestParent = findLatestTaskForSlot(state.tasks, {
      branchIndex: dependency.requiredParentBranchIndex,
      nodeRunId: dependency.requiredParentNodeRunId,
    });

    if (
      !latestParent ||
      !isTaskDependencySatisfiedStatus(latestParent.status)
    ) {
      return null;
    }

    parents.push({ dependency, parent: latestParent });
  }

  return parents;
}

function buildInputSnapshot(
  child: TaskGatekeeperTask,
  parents: readonly {
    readonly dependency: TaskGatekeeperDependency;
    readonly parent: TaskGatekeeperTask;
  }[],
): TaskInputSnapshot {
  const frozenSnapshot = requireInputSnapshot(child);
  return buildTaskInputSnapshot({
    documentRevision: frozenSnapshot.documentRevision,
    branchIndex: child.branchIndex,
    nodeRunId: child.nodeRunId,
    nodeId: child.nodeId,
    resolvedParentTasks: parents.map(({ dependency, parent }) => {
      return {
        address: {
          parentBranchIndex: dependency.requiredParentBranchIndex,
          parentNodeId: dependency.requiredParentNodeId,
          sourceHandle: dependency.sourceHandle ?? null,
          targetHandle: dependency.targetHandle ?? null,
          targetNodeId: dependency.targetNodeId,
        },
        ...(parent.asset ? { asset: parent.asset } : {}),
        branchIndex: parent.branchIndex,
        nodeRunId: parent.nodeRunId,
        ...(parent.output ? { output: parent.output } : {}),
        taskId: parent.id,
      };
    }),
    targetNodeConfig: frozenSnapshot.targetNodeConfig,
    taskId: child.id,
    workflowDefinition: frozenSnapshot.workflowDefinition,
  });
}

function requireInputSnapshot(child: TaskGatekeeperTask) {
  if (!child.inputSnapshot) {
    throw new TypeError(`Missing input snapshot for Task ${child.id}`);
  }
  return child.inputSnapshot;
}

function findWaitingChildren(
  state: TaskGatekeeperState,
  parent: TaskGatekeeperTask,
): readonly TaskGatekeeperTask[] {
  const childIds = new Set(
    state.dependencies
      .filter(
        (dependency) =>
          dependency.resolvedParentTaskId === null &&
          dependency.requiredParentNodeRunId === parent.nodeRunId &&
          dependency.requiredParentBranchIndex === parent.branchIndex,
      )
      .map((dependency) => dependency.childTaskId),
  );

  return state.tasks.filter(
    (task) => childIds.has(task.id) && task.status === "WAITING_UPSTREAM",
  );
}

function failTaskFromUpstream(
  task: TaskGatekeeperTask,
  failedParentTaskId: string,
): TaskGatekeeperTask {
  return {
    ...task,
    failureReason: { failedParentTaskId, type: "UPSTREAM_FAILED" },
    status: "UPSTREAM_FAILED",
  };
}

function buildStatusEvent(task: TaskGatekeeperTask): TaskStatusEvent {
  const event = {
    branchIndex: task.branchIndex,
    nodeRunId: task.nodeRunId,
    status: task.status,
    taskId: task.id,
  } satisfies TaskStatusEvent;

  return buildTaskStatusEvent(
    task.failureReason
      ? { ...event, failureReason: task.failureReason.type }
      : event,
  );
}

function replaceTask(
  state: TaskGatekeeperState,
  task: TaskGatekeeperTask,
): TaskGatekeeperState {
  return {
    ...state,
    tasks: state.tasks.map((candidate) =>
      candidate.id === task.id ? task : candidate,
    ),
  };
}

function findTask(
  tasks: readonly TaskGatekeeperTask[],
  taskId: string,
): TaskGatekeeperTask | undefined {
  return tasks.find((task) => task.id === taskId);
}

function findLatestTaskForSlot(
  tasks: readonly TaskGatekeeperTask[],
  slot: { readonly nodeRunId: string; readonly branchIndex: number },
): TaskGatekeeperTask | undefined {
  return tasks
    .filter(
      (task) =>
        task.nodeRunId === slot.nodeRunId &&
        task.branchIndex === slot.branchIndex,
    )
    .at(-1);
}

function isDependencyFailureStatus(status: TaskStatus): boolean {
  return (
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "UPSTREAM_FAILED"
  );
}

function emptyResult(state: TaskGatekeeperState): TaskGatekeeperResult {
  return { executionJobs: [], state, taskStatusEvents: [] };
}
