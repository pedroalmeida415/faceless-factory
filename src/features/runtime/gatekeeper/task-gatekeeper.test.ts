import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { buildTaskInputSnapshot } from "~/features/runtime/execution/task-input-snapshot";
import {
  recordDirectTaskFailure,
  type TaskGatekeeperDependency,
  type TaskGatekeeperState,
  type TaskGatekeeperTask,
  wakeUpTaskChildren,
} from "~/features/runtime/gatekeeper/task-gatekeeper";
import { createWorkflowNode } from "~/features/workflow/document";

describe("TaskGatekeeper", () => {
  test("queues a waiting child only after every latest required Task is approved", () => {
    const parentA = task({
      id: "parent-a-latest-task",
      nodeRunId: "parent-node-a",
      status: "APPROVED",
    });
    const parentB = task({
      id: "parent-b-latest-task",
      nodeRunId: "parent-node-b",
      status: "APPROVED",
    });
    const child = task({
      creditCost: 30,
      id: "child-task-run",
      nodeRunId: "child-node",
      status: "WAITING_UPSTREAM",
    });
    const state = gatekeeperState({
      creditBalance: 100,
      dependencies: [dependency(child, parentA), dependency(child, parentB)],
      tasks: [parentA, parentB, child],
    });

    const result = wakeUpTaskChildren(state, {
      settledParentTaskId: parentA.id,
    });
    const queuedChild = requireTask(result.state, child.id);

    assert.equal(queuedChild.status, "QUEUED");
    assert.equal(queuedChild.creditCost, 30);
    assert.equal(result.state.creditBalance, 100);
    assert.deepEqual(
      result.state.dependencies.map(
        (candidate) => candidate.resolvedParentTaskId,
      ),
      [parentA.id, parentB.id],
    );
    assert.deepEqual(queuedChild.inputSnapshot, {
      documentRevision: null,
      idempotencyKey: "task:child-task-run",
      branchIndex: 0,
      kind: "task-input-snapshot",
      nodeRunId: "child-node",
      nodeId: "node-child-task-run",
      providerInput: {
        kind: "llm-generation-request",
        request: {
          idempotencyKey: "task:child-task-run",
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
      resolvedParentTasks: [
        {
          address: {
            parentBranchIndex: 0,
            parentNodeId: parentA.nodeId,
            sourceHandle: null,
            targetHandle: null,
            targetNodeId: child.nodeId,
          },
          branchIndex: 0,
          nodeRunId: "parent-node-a",
          taskId: parentA.id,
        },
        {
          address: {
            parentBranchIndex: 0,
            parentNodeId: parentB.nodeId,
            sourceHandle: null,
            targetHandle: null,
            targetNodeId: child.nodeId,
          },
          branchIndex: 0,
          nodeRunId: "parent-node-b",
          taskId: parentB.id,
        },
      ],
      targetNodeConfig: child.targetNodeConfig,
      taskId: child.id,
      version: 1,
      workflowDefinition: child.inputSnapshot?.workflowDefinition,
    });
    assert.deepEqual(result.executionJobs, [
      {
        id: "task~child-task-run~execute",
        inputSnapshot: queuedChild.inputSnapshot,
        taskId: child.id,
      },
    ]);
    assert.deepEqual(result.taskStatusEvents, [
      {
        branchIndex: 0,
        nodeRunId: "child-node",
        status: "QUEUED",
        taskId: child.id,
      },
    ]);
  });

  test("Wake-Up Calls preserve the Waiting Upstream frozen input snapshot metadata", () => {
    const parent = task({
      id: "parent-approved",
      nodeRunId: "parent-node",
      output: {
        assetId: "asset-parent-approved",
        kind: "inline-text-asset",
        text: "approved generated text",
      },
      status: "APPROVED",
    });
    const child = task({
      id: "child-waiting-frozen",
      inputSnapshot: buildTaskInputSnapshot({
        documentRevision: 123,
        branchIndex: 0,
        nodeRunId: "child-node",
        nodeId: "node-child-waiting-frozen",
        resolvedParentTasks: [],
        targetNodeConfig: {
          ...llmGeneratorNode("node-child-waiting-frozen"),
          config: { maxOutputTokens: 512, temperature: 0.4 },
          reviewEnabled: true,
        },
        taskId: "child-waiting-frozen",
      }),
      nodeRunId: "child-node",
      status: "WAITING_UPSTREAM",
    });
    const result = wakeUpTaskChildren(
      gatekeeperState({
        dependencies: [dependency(child, parent)],
        tasks: [parent, child],
      }),
      { settledParentTaskId: parent.id },
    );

    const queuedChild = requireTask(result.state, child.id);
    assert.equal(queuedChild.status, "QUEUED");
    assert.equal(queuedChild.inputSnapshot?.documentRevision, 123);
    assert.equal(
      queuedChild.inputSnapshot?.targetNodeConfig.kind === "llmGenerator"
        ? queuedChild.inputSnapshot.targetNodeConfig.reviewEnabled
        : null,
      true,
    );
    assert.deepEqual(
      queuedChild.inputSnapshot?.targetNodeConfig.kind === "llmGenerator"
        ? queuedChild.inputSnapshot.targetNodeConfig.config
        : null,
      { maxOutputTokens: 512, temperature: 0.4 },
    );
    assert.deepEqual(queuedChild.inputSnapshot?.resolvedParentTasks, [
      {
        address: {
          parentBranchIndex: 0,
          parentNodeId: parent.nodeId,
          sourceHandle: null,
          targetHandle: null,
          targetNodeId: child.nodeId,
        },
        branchIndex: 0,
        nodeRunId: parent.nodeRunId,
        output: parent.output,
        taskId: parent.id,
      },
    ]);
  });

  test("does not treat Pending Review or older approved Tasks as dependency satisfaction", () => {
    const olderApprovedParent = task({
      id: "parent-older-approved-task",
      nodeRunId: "parent-node",
      status: "APPROVED",
    });
    const latestPendingParent = task({
      id: "parent-latest-pending-task",
      nodeRunId: "parent-node",
      status: "PENDING_REVIEW",
    });
    const child = task({
      id: "child-task-run",
      nodeRunId: "child-node",
      status: "WAITING_UPSTREAM",
    });
    const state = gatekeeperState({
      dependencies: [dependency(child, latestPendingParent)],
      tasks: [olderApprovedParent, latestPendingParent, child],
    });

    const result = wakeUpTaskChildren(state, {
      settledParentTaskId: latestPendingParent.id,
    });

    assert.equal(
      requireTask(result.state, child.id).status,
      "WAITING_UPSTREAM",
    );
    assert.equal(result.state.dependencies[0]?.resolvedParentTaskId, null);
    assert.deepEqual(result.executionJobs, []);
    assert.deepEqual(result.taskStatusEvents, []);
  });

  test("stale Wake-Up Calls resolve waiting children from the latest approved Task", () => {
    const staleParent = task({
      id: "parent-stale-task",
      nodeRunId: "parent-node-stale-wake",
      status: "APPROVED",
    });
    const latestParent = task({
      id: "parent-latest-approved-task",
      nodeRunId: "parent-node-stale-wake",
      output: {
        assetId: "latest-parent-output",
        kind: "inline-text-asset",
        text: "latest approved output",
      },
      status: "APPROVED",
    });
    const child = task({
      id: "child-stale-wake-resolves-latest",
      nodeRunId: "child-node-stale-wake",
      status: "WAITING_UPSTREAM",
    });

    const result = wakeUpTaskChildren(
      gatekeeperState({
        dependencies: [dependency(child, staleParent)],
        tasks: [staleParent, latestParent, child],
      }),
      { settledParentTaskId: staleParent.id },
    );
    const queuedChild = requireTask(result.state, child.id);

    assert.equal(queuedChild.status, "QUEUED");
    assert.equal(
      result.state.dependencies[0]?.resolvedParentTaskId,
      latestParent.id,
    );
    assert.deepEqual(queuedChild.inputSnapshot?.resolvedParentTasks, [
      {
        address: {
          parentBranchIndex: 0,
          parentNodeId: staleParent.nodeId,
          sourceHandle: null,
          targetHandle: null,
          targetNodeId: child.nodeId,
        },
        branchIndex: 0,
        nodeRunId: latestParent.nodeRunId,
        output: latestParent.output,
        taskId: latestParent.id,
      },
    ]);
    assert.deepEqual(result.executionJobs, [
      {
        id: "task~child-stale-wake-resolves-latest~execute",
        inputSnapshot: queuedChild.inputSnapshot,
        taskId: child.id,
      },
    ]);
  });

  test("stale Wake-Up Calls cascade waiting children from the latest failed Task", () => {
    const staleParent = task({
      id: "parent-stale-task-before-failure",
      nodeRunId: "parent-node-stale-failure",
      status: "APPROVED",
    });
    const latestParent = task({
      failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
      id: "parent-latest-failed-task",
      nodeRunId: "parent-node-stale-failure",
      status: "FAILED",
    });
    const child = task({
      id: "child-stale-wake-cascades-latest-failure",
      nodeRunId: "child-node-stale-failure",
      status: "WAITING_UPSTREAM",
    });

    const result = wakeUpTaskChildren(
      gatekeeperState({
        dependencies: [dependency(child, staleParent)],
        tasks: [staleParent, latestParent, child],
      }),
      { settledParentTaskId: staleParent.id },
    );

    assert.equal(requireTask(result.state, child.id).status, "UPSTREAM_FAILED");
    assert.deepEqual(requireTask(result.state, child.id).failureReason, {
      failedParentTaskId: latestParent.id,
      type: "UPSTREAM_FAILED",
    });
    assert.deepEqual(result.executionJobs, []);
    assert.deepEqual(result.taskStatusEvents, [
      {
        failureReason: "UPSTREAM_FAILED",
        branchIndex: 0,
        nodeRunId: child.nodeRunId,
        status: "UPSTREAM_FAILED",
        taskId: child.id,
      },
    ]);
  });

  test("keeps non-waiting children immutable and makes duplicate wake-ups idempotent", () => {
    const parent = task({
      id: "parent-task-run",
      nodeRunId: "parent-node",
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
      task({
        id: `already-${status.toLowerCase()}-child`,
        nodeRunId: `child-node-${status.toLowerCase()}`,
        status,
      }),
    );
    const waitingChild = task({
      id: "waiting-child",
      nodeRunId: "waiting-child-node",
      status: "WAITING_UPSTREAM",
    });
    const state = gatekeeperState({
      dependencies: [
        ...nonWaitingChildren.map((child) => dependency(child, parent)),
        dependency(waitingChild, parent),
      ],
      tasks: [parent, ...nonWaitingChildren, waitingChild],
    });

    const first = wakeUpTaskChildren(state, {
      settledParentTaskId: parent.id,
    });
    const second = wakeUpTaskChildren(first.state, {
      settledParentTaskId: parent.id,
    });

    for (const child of nonWaitingChildren) {
      assert.deepEqual(requireTask(first.state, child.id), child);
    }
    assert.equal(first.executionJobs.length, 1);
    assert.equal(first.executionJobs[0]?.taskId, waitingChild.id);
    assert.deepEqual(second.executionJobs, []);
    assert.deepEqual(second.taskStatusEvents, []);
    assert.equal(requireTask(second.state, waitingChild.id).status, "QUEUED");
  });

  test("cascades direct Failed parents to waiting descendants", () => {
    const rootParent = task({
      id: "root-parent",
      nodeRunId: "root-node",
      status: "RUNNING",
    });
    const child = task({
      id: "child-task-run",
      nodeRunId: "child-node",
      status: "WAITING_UPSTREAM",
    });
    const grandchild = task({
      id: "grandchild-task-run",
      nodeRunId: "grandchild-node",
      status: "WAITING_UPSTREAM",
    });
    const state = gatekeeperState({
      dependencies: [
        dependency(child, rootParent),
        dependency(grandchild, child),
      ],
      tasks: [rootParent, child, grandchild],
    });

    const result = recordDirectTaskFailure(state, {
      failureReason: { message: "provider timeout", type: "PROVIDER_FAILED" },
      taskId: rootParent.id,
    });

    assert.equal(requireTask(result.state, rootParent.id).status, "FAILED");
    assert.equal(requireTask(result.state, child.id).status, "UPSTREAM_FAILED");
    assert.deepEqual(requireTask(result.state, child.id).failureReason, {
      failedParentTaskId: rootParent.id,
      type: "UPSTREAM_FAILED",
    });
    assert.equal(
      requireTask(result.state, grandchild.id).status,
      "UPSTREAM_FAILED",
    );
    assert.deepEqual(result.executionJobs, []);
    assert.deepEqual(
      result.taskStatusEvents.map((event) => ({
        failureReason: event.failureReason,
        status: event.status,
        taskId: event.taskId,
      })),
      [
        {
          failureReason: "PROVIDER_FAILED",
          status: "FAILED",
          taskId: rootParent.id,
        },
        {
          failureReason: "UPSTREAM_FAILED",
          status: "UPSTREAM_FAILED",
          taskId: child.id,
        },
        {
          failureReason: "UPSTREAM_FAILED",
          status: "UPSTREAM_FAILED",
          taskId: grandchild.id,
        },
      ],
    );
  });

  test("does not mutate terminal Tasks when direct failure is recorded", () => {
    for (const status of [
      "APPROVED",
      "REJECTED",
      "CANCELLED",
      "FAILED",
      "UPSTREAM_FAILED",
    ] as const) {
      const terminalTask = task({
        failureReason:
          status === "FAILED" ? { type: "INSUFFICIENT_CREDITS" } : undefined,
        id: `${status.toLowerCase()}-task-run`,
        nodeRunId: `${status.toLowerCase()}-node`,
        status,
      });
      const state = gatekeeperState({ tasks: [terminalTask] });

      const result = recordDirectTaskFailure(state, {
        failureReason: { message: "provider timeout", type: "PROVIDER_FAILED" },
        taskId: terminalTask.id,
      });

      assert.deepEqual(
        requireTask(result.state, terminalTask.id),
        terminalTask,
      );
      assert.deepEqual(result.executionJobs, []);
      assert.deepEqual(result.taskStatusEvents, []);
    }
  });

  test("cascades Cancelled and Upstream Failed parent wake-ups to waiting children", () => {
    for (const status of ["CANCELLED", "UPSTREAM_FAILED"] as const) {
      const parent = task({
        id: `${status.toLowerCase()}-parent`,
        nodeRunId: `${status.toLowerCase()}-parent-node`,
        status,
      });
      const child = task({
        id: `${status.toLowerCase()}-child`,
        nodeRunId: `${status.toLowerCase()}-child-node`,
        status: "WAITING_UPSTREAM",
      });
      const state = gatekeeperState({
        dependencies: [dependency(child, parent)],
        tasks: [parent, child],
      });

      const result = wakeUpTaskChildren(state, {
        settledParentTaskId: parent.id,
      });

      assert.equal(
        requireTask(result.state, child.id).status,
        "UPSTREAM_FAILED",
      );
      assert.deepEqual(requireTask(result.state, child.id).failureReason, {
        failedParentTaskId: parent.id,
        type: "UPSTREAM_FAILED",
      });
      assert.deepEqual(result.executionJobs, []);
      assert.deepEqual(result.taskStatusEvents, [
        {
          failureReason: "UPSTREAM_FAILED",
          branchIndex: 0,
          nodeRunId: child.nodeRunId,
          status: "UPSTREAM_FAILED",
          taskId: child.id,
        },
      ]);
    }
  });

  test("queues a ready child without using future credit balance as a readiness check", () => {
    const parent = task({
      id: "approved-parent",
      nodeRunId: "parent-node",
      status: "APPROVED",
    });
    const child = task({
      creditCost: 50,
      id: "expensive-child",
      nodeRunId: "child-node",
      status: "WAITING_UPSTREAM",
    });
    const grandchild = task({
      id: "grandchild-task-run",
      nodeRunId: "grandchild-node",
      status: "WAITING_UPSTREAM",
    });
    const state = gatekeeperState({
      creditBalance: 10,
      dependencies: [dependency(child, parent), dependency(grandchild, child)],
      tasks: [parent, child, grandchild],
    });

    const result = wakeUpTaskChildren(state, {
      settledParentTaskId: parent.id,
    });

    assert.equal(requireTask(result.state, child.id).status, "QUEUED");
    assert.equal(requireTask(result.state, child.id).creditCost, 50);
    assert.equal(result.state.creditBalance, 10);
    assert.equal(
      requireTask(result.state, grandchild.id).status,
      "WAITING_UPSTREAM",
    );
    assert.deepEqual(result.executionJobs, [
      {
        id: "task~expensive-child~execute",
        inputSnapshot: requireTask(result.state, child.id).inputSnapshot,
        taskId: child.id,
      },
    ]);
    assert.deepEqual(
      result.taskStatusEvents.map((event) => ({
        failureReason: event.failureReason,
        status: event.status,
        taskId: event.taskId,
      })),
      [
        {
          failureReason: undefined,
          status: "QUEUED",
          taskId: child.id,
        },
      ],
    );
  });
});

function task(
  overrides: Partial<TaskGatekeeperTask> &
    Pick<TaskGatekeeperTask, "id" | "nodeRunId" | "status">,
): TaskGatekeeperTask {
  const targetNodeConfig = llmGeneratorNode(`node-${overrides.id}`);
  return {
    creditCost: 1,
    inputSnapshot: buildTaskInputSnapshot({
      branchIndex: 0,
      nodeRunId: overrides.nodeRunId,
      nodeId: targetNodeConfig.id,
      resolvedParentTasks: [],
      targetNodeConfig,
      taskId: overrides.id,
    }),
    branchIndex: 0,
    nodeId: `node-${overrides.id}`,
    targetNodeConfig,
    ...overrides,
  };
}

function llmGeneratorNode(id: string) {
  const node = createWorkflowNode("llmGenerator", 0);
  if (node.kind !== "llmGenerator") {
    throw new Error("Expected an LLM generator node.");
  }

  return { ...node, id };
}

function dependency(
  child: TaskGatekeeperTask,
  parent: TaskGatekeeperTask,
): TaskGatekeeperDependency {
  return {
    childTaskId: child.id,
    requiredParentBranchIndex: parent.branchIndex,
    requiredParentNodeId: parent.nodeId,
    requiredParentNodeRunId: parent.nodeRunId,
    resolvedParentTaskId: null,
    targetNodeId: child.nodeId,
  };
}

function gatekeeperState(
  overrides: Partial<TaskGatekeeperState>,
): TaskGatekeeperState {
  return {
    creditBalance: 100,
    dependencies: [],
    tasks: [],
    ...overrides,
  };
}

function requireTask(
  state: TaskGatekeeperState,
  taskId: string,
): TaskGatekeeperTask {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  assert.ok(task);
  return task;
}
