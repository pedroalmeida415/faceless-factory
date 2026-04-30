import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createWorkflowNode } from "~/lib/workflow/document";
import {
  recordDirectTaskRunFailure,
  type TaskRunGatekeeperDependency,
  type TaskRunGatekeeperState,
  type TaskRunGatekeeperTaskRun,
  wakeUpTaskRunChildren,
} from "~/lib/workflow-runtime/gatekeeper/task-run-gatekeeper";

describe("TaskRunGatekeeper", () => {
  test("queues a waiting child only after every latest required Attempt is approved", () => {
    const parentA = taskRun({
      attempt: 1,
      id: "parent-a-attempt-1",
      nodeExecutionId: "parent-node-a",
      status: "APPROVED",
    });
    const parentB = taskRun({
      attempt: 2,
      id: "parent-b-attempt-2",
      nodeExecutionId: "parent-node-b",
      status: "APPROVED",
    });
    const child = taskRun({
      estimatedCreditCost: 30,
      id: "child-task-run",
      nodeExecutionId: "child-node",
      status: "WAITING_UPSTREAM",
    });
    const state = gatekeeperState({
      creditBalance: 100,
      dependencies: [dependency(child, parentA), dependency(child, parentB)],
      taskRuns: [parentA, parentB, child],
    });

    const result = wakeUpTaskRunChildren(state, {
      settledParentTaskRunId: parentA.id,
    });
    const queuedChild = requireTaskRun(result.state, child.id);

    assert.equal(queuedChild.status, "QUEUED");
    assert.equal(queuedChild.reservedCredits, 30);
    assert.equal(result.state.creditBalance, 70);
    assert.deepEqual(
      result.state.dependencies.map(
        (candidate) => candidate.resolvedParentTaskRunId,
      ),
      [parentA.id, parentB.id],
    );
    assert.deepEqual(queuedChild.inputSnapshot, {
      attempt: 0,
      idempotencyKey: "task_run:child-task-run:attempt:0",
      itemIndex: 0,
      kind: "task-run-input-snapshot",
      nodeExecutionId: "child-node",
      nodeId: "node-child-task-run",
      providerInput: {
        kind: "llm-generation-request",
        request: {
          idempotencyKey: "task_run:child-task-run:attempt:0",
          maxOutputTokens: 2048,
          mode: null,
          model: "gemini-3-flash-preview",
          prompt: "",
          referenceImages: [],
          systemPrompt: null,
          temperature: 1,
          thinkingLevel: "LOW",
        },
      },
      resolvedParentTaskRuns: [
        {
          attempt: 1,
          itemIndex: 0,
          nodeExecutionId: "parent-node-a",
          taskRunId: parentA.id,
        },
        {
          attempt: 2,
          itemIndex: 0,
          nodeExecutionId: "parent-node-b",
          taskRunId: parentB.id,
        },
      ],
      targetNodeConfig: child.targetNodeConfig,
      taskRunId: child.id,
      version: 1,
    });
    assert.deepEqual(result.executionJobs, [
      {
        attempt: 0,
        id: "task-run:child-task-run:attempt:0:execute",
        inputSnapshot: queuedChild.inputSnapshot,
        taskRunId: child.id,
      },
    ]);
    assert.deepEqual(result.taskStatusEvents, [
      {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "child-node",
        status: "QUEUED",
        taskRunId: child.id,
      },
    ]);
  });

  test("does not treat Pending Review or older approved Attempts as dependency satisfaction", () => {
    const olderApprovedParent = taskRun({
      attempt: 0,
      id: "parent-attempt-0",
      nodeExecutionId: "parent-node",
      status: "APPROVED",
    });
    const latestPendingParent = taskRun({
      attempt: 1,
      id: "parent-attempt-1",
      nodeExecutionId: "parent-node",
      status: "PENDING_REVIEW",
    });
    const child = taskRun({
      id: "child-task-run",
      nodeExecutionId: "child-node",
      status: "WAITING_UPSTREAM",
    });
    const state = gatekeeperState({
      dependencies: [dependency(child, latestPendingParent)],
      taskRuns: [olderApprovedParent, latestPendingParent, child],
    });

    const result = wakeUpTaskRunChildren(state, {
      settledParentTaskRunId: latestPendingParent.id,
    });

    assert.equal(
      requireTaskRun(result.state, child.id).status,
      "WAITING_UPSTREAM",
    );
    assert.equal(result.state.dependencies[0]?.resolvedParentTaskRunId, null);
    assert.deepEqual(result.executionJobs, []);
    assert.deepEqual(result.taskStatusEvents, []);
  });

  test("keeps non-waiting children immutable and makes duplicate wake-ups idempotent", () => {
    const parent = taskRun({
      id: "parent-task-run",
      nodeExecutionId: "parent-node",
      status: "APPROVED",
    });
    const nonWaitingChildren = (
      [
        "QUEUED",
        "RUNNING",
        "PENDING_REVIEW",
        "APPROVED",
        "REJECTED",
        "CANCELLED",
        "FAILED",
        "UPSTREAM_FAILED",
      ] as const
    ).map((status) =>
      taskRun({
        id: `already-${status.toLowerCase()}-child`,
        nodeExecutionId: `child-node-${status.toLowerCase()}`,
        status,
      }),
    );
    const waitingChild = taskRun({
      id: "waiting-child",
      nodeExecutionId: "waiting-child-node",
      status: "WAITING_UPSTREAM",
    });
    const state = gatekeeperState({
      dependencies: [
        ...nonWaitingChildren.map((child) => dependency(child, parent)),
        dependency(waitingChild, parent),
      ],
      taskRuns: [parent, ...nonWaitingChildren, waitingChild],
    });

    const first = wakeUpTaskRunChildren(state, {
      settledParentTaskRunId: parent.id,
    });
    const second = wakeUpTaskRunChildren(first.state, {
      settledParentTaskRunId: parent.id,
    });

    for (const child of nonWaitingChildren) {
      assert.deepEqual(requireTaskRun(first.state, child.id), child);
    }
    assert.equal(first.executionJobs.length, 1);
    assert.equal(first.executionJobs[0]?.taskRunId, waitingChild.id);
    assert.deepEqual(second.executionJobs, []);
    assert.deepEqual(second.taskStatusEvents, []);
    assert.equal(
      requireTaskRun(second.state, waitingChild.id).status,
      "QUEUED",
    );
  });

  test("cascades direct Failed parents to waiting descendants", () => {
    const rootParent = taskRun({
      id: "root-parent",
      nodeExecutionId: "root-node",
      status: "RUNNING",
    });
    const child = taskRun({
      id: "child-task-run",
      nodeExecutionId: "child-node",
      status: "WAITING_UPSTREAM",
    });
    const grandchild = taskRun({
      id: "grandchild-task-run",
      nodeExecutionId: "grandchild-node",
      status: "WAITING_UPSTREAM",
    });
    const state = gatekeeperState({
      dependencies: [
        dependency(child, rootParent),
        dependency(grandchild, child),
      ],
      taskRuns: [rootParent, child, grandchild],
    });

    const result = recordDirectTaskRunFailure(state, {
      failureReason: { message: "provider timeout", type: "PROVIDER_FAILED" },
      taskRunId: rootParent.id,
    });

    assert.equal(requireTaskRun(result.state, rootParent.id).status, "FAILED");
    assert.equal(
      requireTaskRun(result.state, child.id).status,
      "UPSTREAM_FAILED",
    );
    assert.deepEqual(requireTaskRun(result.state, child.id).failureReason, {
      failedParentTaskRunId: rootParent.id,
      type: "UPSTREAM_FAILED",
    });
    assert.equal(
      requireTaskRun(result.state, grandchild.id).status,
      "UPSTREAM_FAILED",
    );
    assert.deepEqual(result.executionJobs, []);
    assert.deepEqual(
      result.taskStatusEvents.map((event) => ({
        failureReason: event.failureReason,
        status: event.status,
        taskRunId: event.taskRunId,
      })),
      [
        {
          failureReason: "PROVIDER_FAILED",
          status: "FAILED",
          taskRunId: rootParent.id,
        },
        {
          failureReason: "UPSTREAM_FAILED",
          status: "UPSTREAM_FAILED",
          taskRunId: child.id,
        },
        {
          failureReason: "UPSTREAM_FAILED",
          status: "UPSTREAM_FAILED",
          taskRunId: grandchild.id,
        },
      ],
    );
  });

  test("does not mutate terminal Task Runs when direct failure is recorded", () => {
    for (const status of [
      "APPROVED",
      "REJECTED",
      "CANCELLED",
      "FAILED",
      "UPSTREAM_FAILED",
    ] as const) {
      const terminalTaskRun = taskRun({
        failureReason:
          status === "FAILED" ? { type: "INSUFFICIENT_CREDITS" } : undefined,
        id: `${status.toLowerCase()}-task-run`,
        nodeExecutionId: `${status.toLowerCase()}-node`,
        status,
      });
      const state = gatekeeperState({ taskRuns: [terminalTaskRun] });

      const result = recordDirectTaskRunFailure(state, {
        failureReason: { message: "provider timeout", type: "PROVIDER_FAILED" },
        taskRunId: terminalTaskRun.id,
      });

      assert.deepEqual(
        requireTaskRun(result.state, terminalTaskRun.id),
        terminalTaskRun,
      );
      assert.deepEqual(result.executionJobs, []);
      assert.deepEqual(result.taskStatusEvents, []);
    }
  });

  test("cascades Cancelled and Upstream Failed parent wake-ups to waiting children", () => {
    for (const status of ["CANCELLED", "UPSTREAM_FAILED"] as const) {
      const parent = taskRun({
        id: `${status.toLowerCase()}-parent`,
        nodeExecutionId: `${status.toLowerCase()}-parent-node`,
        status,
      });
      const child = taskRun({
        id: `${status.toLowerCase()}-child`,
        nodeExecutionId: `${status.toLowerCase()}-child-node`,
        status: "WAITING_UPSTREAM",
      });
      const state = gatekeeperState({
        dependencies: [dependency(child, parent)],
        taskRuns: [parent, child],
      });

      const result = wakeUpTaskRunChildren(state, {
        settledParentTaskRunId: parent.id,
      });

      assert.equal(
        requireTaskRun(result.state, child.id).status,
        "UPSTREAM_FAILED",
      );
      assert.deepEqual(requireTaskRun(result.state, child.id).failureReason, {
        failedParentTaskRunId: parent.id,
        type: "UPSTREAM_FAILED",
      });
      assert.deepEqual(result.executionJobs, []);
      assert.deepEqual(result.taskStatusEvents, [
        {
          attempt: 0,
          failureReason: "UPSTREAM_FAILED",
          itemIndex: 0,
          nodeExecutionId: child.nodeExecutionId,
          status: "UPSTREAM_FAILED",
          taskRunId: child.id,
        },
      ]);
    }
  });

  test("fails a ready child with insufficient credits before queueing and cascades its waiting descendants", () => {
    const parent = taskRun({
      id: "approved-parent",
      nodeExecutionId: "parent-node",
      status: "APPROVED",
    });
    const child = taskRun({
      estimatedCreditCost: 50,
      id: "expensive-child",
      nodeExecutionId: "child-node",
      status: "WAITING_UPSTREAM",
    });
    const grandchild = taskRun({
      id: "grandchild-task-run",
      nodeExecutionId: "grandchild-node",
      status: "WAITING_UPSTREAM",
    });
    const state = gatekeeperState({
      creditBalance: 10,
      dependencies: [dependency(child, parent), dependency(grandchild, child)],
      taskRuns: [parent, child, grandchild],
    });

    const result = wakeUpTaskRunChildren(state, {
      settledParentTaskRunId: parent.id,
    });

    assert.equal(requireTaskRun(result.state, child.id).status, "FAILED");
    assert.deepEqual(requireTaskRun(result.state, child.id).failureReason, {
      type: "INSUFFICIENT_CREDITS",
    });
    assert.equal(
      requireTaskRun(result.state, child.id).reservedCredits,
      undefined,
    );
    assert.equal(
      requireTaskRun(result.state, child.id).inputSnapshot,
      undefined,
    );
    assert.equal(result.state.creditBalance, 10);
    assert.equal(
      requireTaskRun(result.state, grandchild.id).status,
      "UPSTREAM_FAILED",
    );
    assert.deepEqual(result.executionJobs, []);
    assert.deepEqual(
      result.taskStatusEvents.map((event) => ({
        failureReason: event.failureReason,
        status: event.status,
        taskRunId: event.taskRunId,
      })),
      [
        {
          failureReason: "INSUFFICIENT_CREDITS",
          status: "FAILED",
          taskRunId: child.id,
        },
        {
          failureReason: "UPSTREAM_FAILED",
          status: "UPSTREAM_FAILED",
          taskRunId: grandchild.id,
        },
      ],
    );
  });
});

function taskRun(
  overrides: Partial<TaskRunGatekeeperTaskRun> &
    Pick<TaskRunGatekeeperTaskRun, "id" | "nodeExecutionId" | "status">,
): TaskRunGatekeeperTaskRun {
  return {
    attempt: 0,
    estimatedCreditCost: 1,
    itemIndex: 0,
    nodeId: `node-${overrides.id}`,
    targetNodeConfig: {
      ...createWorkflowNode("llmGenerator", 0),
      id: `node-${overrides.id}`,
    },
    ...overrides,
  };
}

function dependency(
  child: TaskRunGatekeeperTaskRun,
  parent: TaskRunGatekeeperTaskRun,
): TaskRunGatekeeperDependency {
  return {
    childTaskRunId: child.id,
    requiredParentItemIndex: parent.itemIndex,
    requiredParentNodeExecutionId: parent.nodeExecutionId,
    resolvedParentTaskRunId: null,
  };
}

function gatekeeperState(
  overrides: Partial<TaskRunGatekeeperState>,
): TaskRunGatekeeperState {
  return {
    creditBalance: 100,
    dependencies: [],
    taskRuns: [],
    ...overrides,
  };
}

function requireTaskRun(
  state: TaskRunGatekeeperState,
  taskRunId: string,
): TaskRunGatekeeperTaskRun {
  const taskRun = state.taskRuns.find(
    (candidate) => candidate.id === taskRunId,
  );
  assert.ok(taskRun);
  return taskRun;
}
