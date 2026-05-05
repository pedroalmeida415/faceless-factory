import type { WorkflowDefinitionDocumentNode } from "~/lib/workflow/document";
import type { WorkflowAsset } from "~/lib/workflow/types";
import {
  isTaskRunDependencySatisfiedStatus,
  isTerminalTaskRunStatus,
  type TaskRunFailureReason,
  type TaskRunStatus,
} from "~/lib/workflow-runtime/domain/task-run-state";
import {
  buildTaskRunInputSnapshot,
  type ExecutableTaskRunInputSnapshot,
  type TaskRunInputSnapshot,
} from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
import {
  buildExecutionJobId,
  buildTaskStatusEvent,
  type RenderableTaskOutput,
  type TaskStatusEvent,
} from "~/lib/workflow-runtime/runtime/task-status-events";

export type TaskRunGatekeeperTaskRun = {
  readonly id: string;
  readonly nodeExecutionId: string;
  readonly nodeId: string;
  readonly itemIndex: number;
  readonly attempt: number;
  readonly status: TaskRunStatus;
  readonly estimatedCreditCost: number;
  readonly targetNodeConfig?: WorkflowDefinitionDocumentNode;
  readonly asset?: WorkflowAsset;
  readonly output?: RenderableTaskOutput;
  readonly reservedCredits?: number;
  readonly failureReason?: TaskRunFailureReason;
  readonly inputSnapshot?: TaskRunInputSnapshot;
};

export type TaskRunGatekeeperDependency = {
  readonly childTaskRunId: string;
  readonly requiredParentNodeExecutionId: string;
  readonly requiredParentItemIndex: number;
  readonly resolvedParentTaskRunId: string | null;
  readonly requiredParentNodeId: string;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
  readonly targetNodeId: string;
};

export type TaskRunGatekeeperState = {
  readonly creditBalance: number;
  readonly taskRuns: readonly TaskRunGatekeeperTaskRun[];
  readonly dependencies: readonly TaskRunGatekeeperDependency[];
};

export type TaskRunExecutionJobDraft = {
  readonly id: string;
  readonly taskRunId: string;
  readonly attempt: number;
  readonly inputSnapshot: ExecutableTaskRunInputSnapshot;
};

export type TaskRunGatekeeperResult = {
  readonly state: TaskRunGatekeeperState;
  readonly executionJobs: readonly TaskRunExecutionJobDraft[];
  readonly taskStatusEvents: readonly TaskStatusEvent[];
};

export type WakeUpTaskRunChildrenCommand = {
  readonly settledParentTaskRunId: string;
};

export type RecordDirectTaskRunFailureCommand = {
  readonly taskRunId: string;
  readonly failureReason: Exclude<
    TaskRunFailureReason,
    { readonly type: "UPSTREAM_FAILED" }
  >;
};

export function wakeUpTaskRunChildren(
  state: TaskRunGatekeeperState,
  command: WakeUpTaskRunChildrenCommand,
): TaskRunGatekeeperResult {
  const parent = findTaskRun(state.taskRuns, command.settledParentTaskRunId);
  if (!parent) {
    return emptyResult(state);
  }

  return runGatekeeper(state, [parent]);
}

export function recordDirectTaskRunFailure(
  state: TaskRunGatekeeperState,
  command: RecordDirectTaskRunFailureCommand,
): TaskRunGatekeeperResult {
  const failedTaskRun = findTaskRun(state.taskRuns, command.taskRunId);
  if (!failedTaskRun || isTerminalTaskRunStatus(failedTaskRun.status)) {
    return emptyResult(state);
  }

  const nextTaskRun = {
    ...failedTaskRun,
    failureReason: command.failureReason,
    status: "FAILED",
  } satisfies TaskRunGatekeeperTaskRun;
  const nextState = replaceTaskRun(state, nextTaskRun);
  const result = runGatekeeper(nextState, [nextTaskRun]);

  return {
    ...result,
    taskStatusEvents: [
      buildStatusEvent(nextTaskRun),
      ...result.taskStatusEvents,
    ],
  };
}

function runGatekeeper(
  state: TaskRunGatekeeperState,
  settledParents: readonly TaskRunGatekeeperTaskRun[],
): TaskRunGatekeeperResult {
  let nextState = state;
  const executionJobs: TaskRunExecutionJobDraft[] = [];
  const taskStatusEvents: TaskStatusEvent[] = [];
  const cascadeQueue = [...settledParents];

  for (let index = 0; index < cascadeQueue.length; index += 1) {
    const settledParent = cascadeQueue[index];
    if (!settledParent) {
      continue;
    }

    for (const child of findWaitingChildren(nextState, settledParent)) {
      const latestRequiredParent = findLatestTaskRunForSlot(
        nextState.taskRuns,
        settledParent,
      );
      if (!latestRequiredParent) {
        continue;
      }

      if (isDependencyFailureStatus(latestRequiredParent.status)) {
        const upstreamFailedChild = failTaskRunFromUpstream(
          child,
          latestRequiredParent.id,
        );
        nextState = replaceTaskRun(nextState, upstreamFailedChild);
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
        } satisfies TaskRunGatekeeperTaskRun;
        nextState = replaceTaskRun(nextState, failedChild);
        taskStatusEvents.push(buildStatusEvent(failedChild));
        cascadeQueue.push(failedChild);
        continue;
      }
      const executableInputSnapshot: ExecutableTaskRunInputSnapshot = {
        ...inputSnapshot,
        providerInput: inputSnapshot.providerInput,
      };

      const queuedChild = {
        ...child,
        inputSnapshot: executableInputSnapshot,
        reservedCredits: child.estimatedCreditCost,
        status: "QUEUED",
      } satisfies TaskRunGatekeeperTaskRun;

      nextState = {
        creditBalance: nextState.creditBalance,
        dependencies: nextState.dependencies.map((dependency) => {
          if (dependency.childTaskRunId !== child.id) {
            return dependency;
          }

          const resolvedDependency = resolvedDependencies.find(
            (candidate) => candidate.dependency === dependency,
          );

          return resolvedDependency
            ? {
                ...dependency,
                resolvedParentTaskRunId: resolvedDependency.parent.id,
              }
            : dependency;
        }),
        taskRuns: nextState.taskRuns.map((taskRun) =>
          taskRun.id === queuedChild.id ? queuedChild : taskRun,
        ),
      };
      executionJobs.push({
        attempt: queuedChild.attempt,
        id: buildExecutionJobId({
          attempt: queuedChild.attempt,
          taskRunId: queuedChild.id,
        }),
        inputSnapshot: executableInputSnapshot,
        taskRunId: queuedChild.id,
      });
      taskStatusEvents.push(buildStatusEvent(queuedChild));
    }
  }

  return { executionJobs, state: nextState, taskStatusEvents };
}

function resolveReadyParentDependencies(
  state: TaskRunGatekeeperState,
  childTaskRunId: string,
):
  | readonly {
      readonly dependency: TaskRunGatekeeperDependency;
      readonly parent: TaskRunGatekeeperTaskRun;
    }[]
  | null {
  const dependencies = state.dependencies.filter(
    (dependency) => dependency.childTaskRunId === childTaskRunId,
  );
  const parents: {
    readonly dependency: TaskRunGatekeeperDependency;
    readonly parent: TaskRunGatekeeperTaskRun;
  }[] = [];

  for (const dependency of dependencies) {
    const latestParent = findLatestTaskRunForSlot(state.taskRuns, {
      itemIndex: dependency.requiredParentItemIndex,
      nodeExecutionId: dependency.requiredParentNodeExecutionId,
    });

    if (
      !latestParent ||
      !isTaskRunDependencySatisfiedStatus(latestParent.status)
    ) {
      return null;
    }

    parents.push({ dependency, parent: latestParent });
  }

  return parents;
}

function buildInputSnapshot(
  child: TaskRunGatekeeperTaskRun,
  parents: readonly {
    readonly dependency: TaskRunGatekeeperDependency;
    readonly parent: TaskRunGatekeeperTaskRun;
  }[],
): TaskRunInputSnapshot {
  const frozenSnapshot = requireInputSnapshot(child);
  return buildTaskRunInputSnapshot({
    attempt: child.attempt,
    documentRevision: frozenSnapshot.documentRevision,
    itemIndex: child.itemIndex,
    nodeExecutionId: child.nodeExecutionId,
    nodeId: child.nodeId,
    resolvedParentTaskRuns: parents.map(({ dependency, parent }) => {
      return {
        address: {
          parentItemIndex: dependency.requiredParentItemIndex,
          parentNodeId: dependency.requiredParentNodeId,
          sourceHandle: dependency.sourceHandle ?? null,
          targetHandle: dependency.targetHandle ?? null,
          targetNodeId: dependency.targetNodeId,
        },
        attempt: parent.attempt,
        ...(parent.asset ? { asset: parent.asset } : {}),
        itemIndex: parent.itemIndex,
        nodeExecutionId: parent.nodeExecutionId,
        ...(parent.output ? { output: parent.output } : {}),
        taskRunId: parent.id,
      };
    }),
    targetNodeConfig: frozenSnapshot.targetNodeConfig,
    taskRunId: child.id,
    workflowDefinition: frozenSnapshot.workflowDefinition,
  });
}

function requireInputSnapshot(child: TaskRunGatekeeperTaskRun) {
  if (!child.inputSnapshot) {
    throw new TypeError(`Missing input snapshot for Task Run ${child.id}`);
  }
  return child.inputSnapshot;
}

function findWaitingChildren(
  state: TaskRunGatekeeperState,
  parent: TaskRunGatekeeperTaskRun,
): readonly TaskRunGatekeeperTaskRun[] {
  const childIds = new Set(
    state.dependencies
      .filter(
        (dependency) =>
          dependency.resolvedParentTaskRunId === null &&
          dependency.requiredParentNodeExecutionId === parent.nodeExecutionId &&
          dependency.requiredParentItemIndex === parent.itemIndex,
      )
      .map((dependency) => dependency.childTaskRunId),
  );

  return state.taskRuns.filter(
    (taskRun) =>
      childIds.has(taskRun.id) && taskRun.status === "WAITING_UPSTREAM",
  );
}

function failTaskRunFromUpstream(
  taskRun: TaskRunGatekeeperTaskRun,
  failedParentTaskRunId: string,
): TaskRunGatekeeperTaskRun {
  return {
    ...taskRun,
    failureReason: { failedParentTaskRunId, type: "UPSTREAM_FAILED" },
    status: "UPSTREAM_FAILED",
  };
}

function buildStatusEvent(taskRun: TaskRunGatekeeperTaskRun): TaskStatusEvent {
  const event = {
    attempt: taskRun.attempt,
    itemIndex: taskRun.itemIndex,
    nodeExecutionId: taskRun.nodeExecutionId,
    status: taskRun.status,
    taskRunId: taskRun.id,
  } satisfies TaskStatusEvent;

  return buildTaskStatusEvent(
    taskRun.failureReason
      ? { ...event, failureReason: taskRun.failureReason.type }
      : event,
  );
}

function replaceTaskRun(
  state: TaskRunGatekeeperState,
  taskRun: TaskRunGatekeeperTaskRun,
): TaskRunGatekeeperState {
  return {
    ...state,
    taskRuns: state.taskRuns.map((candidate) =>
      candidate.id === taskRun.id ? taskRun : candidate,
    ),
  };
}

function findTaskRun(
  taskRuns: readonly TaskRunGatekeeperTaskRun[],
  taskRunId: string,
): TaskRunGatekeeperTaskRun | undefined {
  return taskRuns.find((taskRun) => taskRun.id === taskRunId);
}

function findLatestTaskRunForSlot(
  taskRuns: readonly TaskRunGatekeeperTaskRun[],
  slot: { readonly nodeExecutionId: string; readonly itemIndex: number },
): TaskRunGatekeeperTaskRun | undefined {
  return taskRuns
    .filter(
      (taskRun) =>
        taskRun.nodeExecutionId === slot.nodeExecutionId &&
        taskRun.itemIndex === slot.itemIndex,
    )
    .sort((left, right) => right.attempt - left.attempt)[0];
}

function isDependencyFailureStatus(status: TaskRunStatus): boolean {
  return (
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "UPSTREAM_FAILED"
  );
}

function emptyResult(state: TaskRunGatekeeperState): TaskRunGatekeeperResult {
  return { executionJobs: [], state, taskStatusEvents: [] };
}
