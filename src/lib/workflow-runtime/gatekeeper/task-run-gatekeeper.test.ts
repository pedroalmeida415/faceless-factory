import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import { createWorkflowNode } from "~/lib/workflow/document";
import { buildTaskRunInputSnapshot } from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
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
      creditCost: 30,
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
    assert.equal(queuedChild.creditCost, 30);
    assert.equal(result.state.creditBalance, 100);
    assert.deepEqual(
      result.state.dependencies.map(
        (candidate) => candidate.resolvedParentTaskRunId,
      ),
      [parentA.id, parentB.id],
    );
    assert.deepEqual(queuedChild.inputSnapshot, {
      attempt: 0,
      documentRevision: null,
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
          address: {
            parentItemIndex: 0,
            parentNodeId: parentA.nodeId,
            sourceHandle: null,
            targetHandle: null,
            targetNodeId: child.nodeId,
          },
          attempt: 1,
          itemIndex: 0,
          nodeExecutionId: "parent-node-a",
          taskRunId: parentA.id,
        },
        {
          address: {
            parentItemIndex: 0,
            parentNodeId: parentB.nodeId,
            sourceHandle: null,
            targetHandle: null,
            targetNodeId: child.nodeId,
          },
          attempt: 2,
          itemIndex: 0,
          nodeExecutionId: "parent-node-b",
          taskRunId: parentB.id,
        },
      ],
      targetNodeConfig: child.targetNodeConfig,
      taskRunId: child.id,
      version: 1,
      workflowDefinition: child.inputSnapshot?.workflowDefinition,
    });
    assert.deepEqual(result.executionJobs, [
      {
        attempt: 0,
        id: "task-run~child-task-run~attempt~0~execute",
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

  test("Wake-Up Calls preserve the Waiting Upstream frozen input snapshot metadata", () => {
    const parent = taskRun({
      id: "parent-approved",
      nodeExecutionId: "parent-node",
      output: {
        assetId: "asset-parent-approved",
        kind: "inline-text-asset",
        text: "approved generated text",
      },
      status: "APPROVED",
    });
    const child = taskRun({
      id: "child-waiting-frozen",
      inputSnapshot: buildTaskRunInputSnapshot({
        attempt: 0,
        documentRevision: 123,
        itemIndex: 0,
        nodeExecutionId: "child-node",
        nodeId: "node-child-waiting-frozen",
        resolvedParentTaskRuns: [],
        targetNodeConfig: {
          ...llmGeneratorNode("node-child-waiting-frozen"),
          config: { maxOutputTokens: 512, temperature: 0.4 },
          reviewEnabled: true,
        },
        taskRunId: "child-waiting-frozen",
      }),
      nodeExecutionId: "child-node",
      status: "WAITING_UPSTREAM",
    });
    const result = wakeUpTaskRunChildren(
      gatekeeperState({
        dependencies: [dependency(child, parent)],
        taskRuns: [parent, child],
      }),
      { settledParentTaskRunId: parent.id },
    );

    const queuedChild = requireTaskRun(result.state, child.id);
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
    assert.deepEqual(queuedChild.inputSnapshot?.resolvedParentTaskRuns, [
      {
        address: {
          parentItemIndex: 0,
          parentNodeId: parent.nodeId,
          sourceHandle: null,
          targetHandle: null,
          targetNodeId: child.nodeId,
        },
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: parent.nodeExecutionId,
        output: parent.output,
        taskRunId: parent.id,
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

  test("stale Wake-Up Calls resolve waiting children from the latest approved Attempt", () => {
    const staleParent = taskRun({
      attempt: 0,
      id: "parent-attempt-0-stale",
      nodeExecutionId: "parent-node-stale-wake",
      status: "APPROVED",
    });
    const latestParent = taskRun({
      attempt: 1,
      id: "parent-attempt-1-latest",
      nodeExecutionId: "parent-node-stale-wake",
      output: {
        assetId: "latest-parent-output",
        kind: "inline-text-asset",
        text: "latest approved output",
      },
      status: "APPROVED",
    });
    const child = taskRun({
      id: "child-stale-wake-resolves-latest",
      nodeExecutionId: "child-node-stale-wake",
      status: "WAITING_UPSTREAM",
    });

    const result = wakeUpTaskRunChildren(
      gatekeeperState({
        dependencies: [dependency(child, staleParent)],
        taskRuns: [staleParent, latestParent, child],
      }),
      { settledParentTaskRunId: staleParent.id },
    );
    const queuedChild = requireTaskRun(result.state, child.id);

    assert.equal(queuedChild.status, "QUEUED");
    assert.equal(
      result.state.dependencies[0]?.resolvedParentTaskRunId,
      latestParent.id,
    );
    assert.deepEqual(queuedChild.inputSnapshot?.resolvedParentTaskRuns, [
      {
        address: {
          parentItemIndex: 0,
          parentNodeId: staleParent.nodeId,
          sourceHandle: null,
          targetHandle: null,
          targetNodeId: child.nodeId,
        },
        attempt: 1,
        itemIndex: 0,
        nodeExecutionId: latestParent.nodeExecutionId,
        output: latestParent.output,
        taskRunId: latestParent.id,
      },
    ]);
    assert.deepEqual(result.executionJobs, [
      {
        attempt: 0,
        id: "task-run~child-stale-wake-resolves-latest~attempt~0~execute",
        inputSnapshot: queuedChild.inputSnapshot,
        taskRunId: child.id,
      },
    ]);
  });

  test("stale Wake-Up Calls cascade waiting children from the latest failed Attempt", () => {
    const staleParent = taskRun({
      attempt: 0,
      id: "parent-attempt-0-before-failure",
      nodeExecutionId: "parent-node-stale-failure",
      status: "APPROVED",
    });
    const latestParent = taskRun({
      attempt: 1,
      failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
      id: "parent-attempt-1-failed",
      nodeExecutionId: "parent-node-stale-failure",
      status: "FAILED",
    });
    const child = taskRun({
      id: "child-stale-wake-cascades-latest-failure",
      nodeExecutionId: "child-node-stale-failure",
      status: "WAITING_UPSTREAM",
    });

    const result = wakeUpTaskRunChildren(
      gatekeeperState({
        dependencies: [dependency(child, staleParent)],
        taskRuns: [staleParent, latestParent, child],
      }),
      { settledParentTaskRunId: staleParent.id },
    );

    assert.equal(
      requireTaskRun(result.state, child.id).status,
      "UPSTREAM_FAILED",
    );
    assert.deepEqual(requireTaskRun(result.state, child.id).failureReason, {
      failedParentTaskRunId: latestParent.id,
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

  test("queues a ready child without using future credit balance as a readiness check", () => {
    const parent = taskRun({
      id: "approved-parent",
      nodeExecutionId: "parent-node",
      status: "APPROVED",
    });
    const child = taskRun({
      creditCost: 50,
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

    assert.equal(requireTaskRun(result.state, child.id).status, "QUEUED");
    assert.equal(requireTaskRun(result.state, child.id).creditCost, 50);
    assert.equal(result.state.creditBalance, 10);
    assert.equal(
      requireTaskRun(result.state, grandchild.id).status,
      "WAITING_UPSTREAM",
    );
    assert.deepEqual(result.executionJobs, [
      {
        attempt: 0,
        id: "task-run~expensive-child~attempt~0~execute",
        inputSnapshot: requireTaskRun(result.state, child.id).inputSnapshot,
        taskRunId: child.id,
      },
    ]);
    assert.deepEqual(
      result.taskStatusEvents.map((event) => ({
        failureReason: event.failureReason,
        status: event.status,
        taskRunId: event.taskRunId,
      })),
      [
        {
          failureReason: undefined,
          status: "QUEUED",
          taskRunId: child.id,
        },
      ],
    );
  });
});

function taskRun(
  overrides: Partial<TaskRunGatekeeperTaskRun> &
    Pick<TaskRunGatekeeperTaskRun, "id" | "nodeExecutionId" | "status">,
): TaskRunGatekeeperTaskRun {
  const targetNodeConfig = llmGeneratorNode(`node-${overrides.id}`);
  return {
    attempt: 0,
    creditCost: 1,
    inputSnapshot: buildTaskRunInputSnapshot({
      attempt: 0,
      itemIndex: 0,
      nodeExecutionId: overrides.nodeExecutionId,
      nodeId: targetNodeConfig.id,
      resolvedParentTaskRuns: [],
      targetNodeConfig,
      taskRunId: overrides.id,
    }),
    itemIndex: 0,
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
  child: TaskRunGatekeeperTaskRun,
  parent: TaskRunGatekeeperTaskRun,
): TaskRunGatekeeperDependency {
  return {
    childTaskRunId: child.id,
    requiredParentItemIndex: parent.itemIndex,
    requiredParentNodeId: parent.nodeId,
    requiredParentNodeExecutionId: parent.nodeExecutionId,
    resolvedParentTaskRunId: null,
    targetNodeId: child.nodeId,
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
