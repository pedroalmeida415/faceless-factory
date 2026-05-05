import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import type { WorkflowRunPlan } from "~/lib/workflow-runtime/planning/workflow-run-planner";
import type { TaskStatusEvent } from "~/lib/workflow-runtime/runtime/task-status-events";
import type {
  WakeUpTaskRunChildrenRepositoryCommand,
  WakeUpTaskRunChildrenRepositoryResult,
} from "~/server/workflow-runtime/workflow-runtime-gatekeeper-repository";
import {
  createWorkflowRuntimeOrchestrator,
  type RejectTaskRunCommand,
  type ReviewTaskRunDecisionCommand,
  type SettleWorkerCompletionCommand,
  type SettleWorkerFailureCommand,
} from "~/server/workflow-runtime/workflow-runtime-orchestrator";
import type {
  WorkflowRuntimeExecutionJobPayload,
  WorkflowRuntimeWakeUpJobPayload,
} from "~/server/workflow-runtime/workflow-runtime-queue";

describe("WorkflowRuntimeOrchestrator", () => {
  test("commits a planned run before enqueueing execution jobs and publishing Task Status Events", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    const queue = new FakeQueue(sideEffects);
    const eventPublisher = new FakeEventPublisher(sideEffects);
    const orchestrator = createWorkflowRuntimeOrchestrator({
      createNodeExecutionId: nextId("node-execution"),
      createTaskRunId: nextId("task-run"),
      eventPublisher,
      queue,
      repository,
    });

    const result = await orchestrator.startWorkflowRun({
      command: { type: "run-target", targetNodeIds: ["script"] },
      document: makeDocument(),
      latestNodeExecutions: [
        { id: "topic-execution", nodeId: "topic" },
        { id: "prompt-execution", nodeId: "prompt" },
      ],
      latestTaskRuns: [
        {
          attempt: 0,
          id: "topic-task",
          itemIndex: 0,
          nodeExecutionId: "topic-execution",
          status: "APPROVED",
        },
        {
          attempt: 0,
          id: "prompt-task",
          itemIndex: 0,
          nodeExecutionId: "prompt-execution",
          status: "APPROVED",
        },
      ],
      ownerId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(sideEffects, [
      "commit:task-run-1",
      "enqueue:task-run~task-run-1~attempt~0~execute",
      "publish:workflow-1:task-run-1",
    ]);
    assert.deepEqual(
      repository.committedPlans.map((plan) =>
        plan.taskRunsToCreate.map((taskRun) => taskRun.id),
      ),
      [["task-run-1"]],
    );
  });

  test("enqueues post-commit Wake-Up Calls from initially failed Task Runs", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.commitResultOverride = {
      executionJobs: [],
      taskStatusEvents: [makeTaskStatusEvent("FAILED")],
      wakeUpJobs: [makeWakeUpJob()],
    };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      createNodeExecutionId: nextId("node-execution"),
      createTaskRunId: nextId("task-run"),
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const result = await orchestrator.startWorkflowRun(runScriptInput());

    assert.equal(result.ok, true);
    assert.deepEqual(sideEffects, [
      "commit:task-run-1",
      "enqueue-wake-up~wake-up~task-run-1",
      "publish:workflow-1:task-run-1",
    ]);
  });

  test("returns planning failures without committing, enqueueing, or publishing", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    const orchestrator = createWorkflowRuntimeOrchestrator({
      createNodeExecutionId: nextId("node-execution"),
      createTaskRunId: nextId("task-run"),
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const result = await orchestrator.startWorkflowRun({
      command: { type: "run-target", targetNodeIds: ["missing-node"] },
      document: makeDocument(),
      latestNodeExecutions: [],
      latestTaskRuns: [],
      ownerId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "WorkflowRunPlannerError");
    assert.equal(result.error.committed, false);
    assert.deepEqual(repository.committedPlans, []);
    assert.deepEqual(sideEffects, []);
  });

  test("returns commit failures without enqueueing or publishing", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.commitError = new Error("database unavailable");
    const orchestrator = createWorkflowRuntimeOrchestrator({
      createNodeExecutionId: nextId("node-execution"),
      createTaskRunId: nextId("task-run"),
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const result = await orchestrator.startWorkflowRun(runScriptInput());

    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "WorkflowRuntimeCommitError");
    assert.equal(result.error.committed, false);
    assert.equal(result.error.cause, repository.commitError);
    assert.deepEqual(sideEffects, ["commit-attempt"]);
  });

  test("returns enqueue failures as post-commit failures without publishing", async () => {
    const sideEffects: string[] = [];
    const queue = new FakeQueue(sideEffects);
    queue.enqueueError = new Error("queue unavailable");
    const orchestrator = createWorkflowRuntimeOrchestrator({
      createNodeExecutionId: nextId("node-execution"),
      createTaskRunId: nextId("task-run"),
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue,
      repository: new FakeRepository(sideEffects),
    });

    const result = await orchestrator.startWorkflowRun(runScriptInput());

    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "WorkflowRuntimePostCommitSideEffectError");
    assert.equal(result.error.committed, true);
    assert.equal(result.error.sideEffect, "enqueue-execution-jobs");
    assert.equal(result.error.cause, queue.enqueueError);
    assert.deepEqual(sideEffects, ["commit:task-run-1", "enqueue-attempt"]);
  });

  test("returns publish failures as post-commit failures after enqueueing", async () => {
    const sideEffects: string[] = [];
    const eventPublisher = new FakeEventPublisher(sideEffects);
    eventPublisher.publishError = new Error("pubsub unavailable");
    const orchestrator = createWorkflowRuntimeOrchestrator({
      createNodeExecutionId: nextId("node-execution"),
      createTaskRunId: nextId("task-run"),
      eventPublisher,
      queue: new FakeQueue(sideEffects),
      repository: new FakeRepository(sideEffects),
    });

    const result = await orchestrator.startWorkflowRun(runScriptInput());

    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "WorkflowRuntimePostCommitSideEffectError");
    assert.equal(result.error.committed, true);
    assert.equal(result.error.sideEffect, "publish-task-status-events");
    assert.equal(result.error.cause, eventPublisher.publishError);
    assert.deepEqual(sideEffects, [
      "commit:task-run-1",
      "enqueue:task-run~task-run-1~attempt~0~execute",
      "publish-attempt:workflow-1",
    ]);
  });

  test("delegates rerun-node and regenerate-item commands to the planner", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    const orchestrator = createWorkflowRuntimeOrchestrator({
      createNodeExecutionId: nextId("node-execution"),
      createTaskRunId: nextId("task-run"),
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const rerun = await orchestrator.startWorkflowRun({
      command: { type: "rerun-node", nodeId: "script" },
      document: makeDocument(),
      latestNodeExecutions: [],
      latestTaskRuns: [],
      ownerId: "owner-1",
      workflowId: "workflow-1",
    });
    const regenerate = await orchestrator.startWorkflowRun({
      command: {
        type: "regenerate-item",
        itemIndexes: [0],
        nodeExecutionId: "script-execution",
      },
      document: makeDocument(),
      latestNodeExecutions: [
        { id: "prompt-execution", nodeId: "prompt" },
        { id: "script-execution", nodeId: "script" },
      ],
      latestTaskRuns: [
        {
          attempt: 0,
          id: "prompt-task-0",
          itemIndex: 0,
          nodeExecutionId: "prompt-execution",
          status: "APPROVED",
        },
        {
          attempt: 0,
          id: "script-task-0",
          itemIndex: 0,
          nodeExecutionId: "script-execution",
          status: "APPROVED",
        },
      ],
      ownerId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.equal(rerun.ok, true);
    assert.equal(regenerate.ok, true);
    assert.deepEqual(
      repository.committedPlans.map((plan) => ({
        createdNodeExecutions: plan.nodeExecutionsToCreate.map(
          (execution) => execution.nodeId,
        ),
        reusedNodeExecutions: plan.nodeExecutionsToReuse.map(
          (execution) => execution.id,
        ),
        taskAttempts: plan.taskRunsToCreate.map((taskRun) => taskRun.attempt),
      })),
      [
        {
          createdNodeExecutions: ["script"],
          reusedNodeExecutions: [],
          taskAttempts: [0],
        },
        {
          createdNodeExecutions: [],
          reusedNodeExecutions: ["script-execution"],
          taskAttempts: [1],
        },
      ],
    );
  });

  test("settles worker completion before enqueueing wake-up jobs and publishing Task Status Events", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.completionResult = {
      event: makeTaskStatusEvent("APPROVED"),
      settled: true,
      wakeUpJob: makeWakeUpJob(),
    };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const command = makeCompletionCommand();
    const result = await orchestrator.settleWorkerCompletion(command);

    assert.equal(result.ok, true);
    assert.deepEqual(repository.completionCommands, [command]);
    assert.deepEqual(sideEffects, [
      "settle-completion:task-run-1",
      "enqueue-wake-up~wake-up~task-run-1",
      "publish:workflow-1:task-run-1",
    ]);
  });

  test("settles worker completion without wake-up enqueueing when review is still pending", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.completionResult = {
      event: makeTaskStatusEvent("PENDING_REVIEW"),
      settled: true,
      wakeUpJob: null,
    };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const result = await orchestrator.settleWorkerCompletion(
      makeCompletionCommand(),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(sideEffects, [
      "settle-completion:task-run-1",
      "publish:workflow-1:task-run-1",
    ]);
  });

  test("does not enqueue or publish when worker completion was already settled", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.completionResult = { settled: false };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const result = await orchestrator.settleWorkerCompletion(
      makeCompletionCommand(),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(sideEffects, ["settle-completion:task-run-1"]);
  });

  test("returns completion wake-up enqueue failures as committed post-commit failures", async () => {
    const sideEffects: string[] = [];
    const queue = new FakeQueue(sideEffects);
    queue.enqueueWakeUpError = new Error("queue unavailable");
    const repository = new FakeRepository(sideEffects);
    repository.completionResult = {
      event: makeTaskStatusEvent("APPROVED"),
      settled: true,
      wakeUpJob: makeWakeUpJob(),
    };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue,
      repository,
    });

    const result = await orchestrator.settleWorkerCompletion(
      makeCompletionCommand(),
    );

    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "WorkflowRuntimePostCommitSideEffectError");
    assert.equal(result.error.committed, true);
    assert.equal(result.error.sideEffect, "enqueue-wake-up-jobs");
    assert.equal(result.error.cause, queue.enqueueWakeUpError);
    assert.deepEqual(sideEffects, [
      "settle-completion:task-run-1",
      "enqueue-wake-up~attempt",
    ]);
  });

  test("approves a review decision before enqueueing wake-up jobs and publishing Task Status Events", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.approveResult = {
      decided: true,
      event: makeTaskStatusEvent("APPROVED"),
      wakeUpJob: makeWakeUpJob(),
    };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const command = makeReviewDecisionCommand();
    const result = await orchestrator.approveTaskRun(command);

    assert.equal(result.ok, true);
    assert.deepEqual(repository.approveCommands, [command]);
    assert.deepEqual(sideEffects, [
      "approve:task-run-1",
      "enqueue-wake-up~wake-up~task-run-1",
      "publish:workflow-1:task-run-1",
    ]);
  });

  test("does not enqueue or publish when a review approval was already decided", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.approveResult = { decided: false };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const result = await orchestrator.approveTaskRun(
      makeReviewDecisionCommand(),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(sideEffects, ["approve:task-run-1"]);
  });

  test("cancels a Task Run before enqueueing downstream wake-up jobs and publishing Task Status Events", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.cancelResult = {
      decided: true,
      event: makeTaskStatusEvent("CANCELLED"),
      wakeUpJob: makeWakeUpJob(),
    };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const command = makeReviewDecisionCommand();
    const result = await orchestrator.cancelTaskRun(command);

    assert.equal(result.ok, true);
    assert.deepEqual(repository.cancelCommands, [command]);
    assert.deepEqual(sideEffects, [
      "cancel:task-run-1",
      "enqueue-wake-up~wake-up~task-run-1",
      "publish:workflow-1:task-run-1",
    ]);
  });

  test("rejects a Task Run before enqueueing the regeneration execution job and publishing both Task Status Events", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.rejectResult = {
      executionJob: makeExecutionJob(),
      rejected: true,
      taskStatusEvents: [
        makeTaskStatusEvent("REJECTED"),
        { ...makeTaskStatusEvent("QUEUED"), taskRunId: "task-run-2" },
      ],
    };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      createTaskRunId: () => "task-run-2",
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const command = makeRejectTaskRunCommand();
    const result = await orchestrator.rejectTaskRun(command);

    assert.equal(result.ok, true);
    assert.deepEqual(repository.rejectCommands, [
      { ...command, newTaskRunId: "task-run-2" },
    ]);
    assert.deepEqual(sideEffects, [
      "reject:task-run-1",
      "enqueue:task-run~task-run-1~attempt~0~execute",
      "publish:workflow-1:task-run-1",
      "publish:workflow-1:task-run-2",
    ]);
  });

  test("does not enqueue or publish when rejection was already decided", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.rejectResult = { rejected: false };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      createTaskRunId: () => "task-run-2",
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const result = await orchestrator.rejectTaskRun(makeRejectTaskRunCommand());

    assert.equal(result.ok, true);
    assert.deepEqual(sideEffects, ["reject:task-run-1"]);
  });

  test("returns review decision wake-up enqueue failures as committed post-commit failures", async () => {
    const sideEffects: string[] = [];
    const queue = new FakeQueue(sideEffects);
    queue.enqueueWakeUpError = new Error("queue unavailable");
    const repository = new FakeRepository(sideEffects);
    repository.cancelResult = {
      decided: true,
      event: makeTaskStatusEvent("CANCELLED"),
      wakeUpJob: makeWakeUpJob(),
    };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue,
      repository,
    });

    const result = await orchestrator.cancelTaskRun(
      makeReviewDecisionCommand(),
    );

    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "WorkflowRuntimePostCommitSideEffectError");
    assert.equal(result.error.committed, true);
    assert.equal(result.error.sideEffect, "enqueue-wake-up-jobs");
    assert.equal(result.error.cause, queue.enqueueWakeUpError);
    assert.deepEqual(sideEffects, [
      "cancel:task-run-1",
      "enqueue-wake-up~attempt",
    ]);
  });

  test("settles worker failure before enqueueing wake-up jobs and publishing failure events", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.failureResult = {
      event: makeTaskStatusEvent("FAILED"),
      settled: true,
      wakeUpJob: makeWakeUpJob(),
    };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const command = makeFailureCommand();
    const result = await orchestrator.settleWorkerFailure(command);

    assert.equal(result.ok, true);
    assert.deepEqual(repository.failureCommands, [command]);
    assert.deepEqual(sideEffects, [
      "settle-failure:task-run-1",
      "enqueue-wake-up~wake-up~task-run-1",
      "publish:workflow-1:task-run-1",
    ]);
  });

  test("does not enqueue or publish when worker failure was already settled", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.failureResult = { settled: false };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const result = await orchestrator.settleWorkerFailure(makeFailureCommand());

    assert.equal(result.ok, true);
    assert.deepEqual(sideEffects, ["settle-failure:task-run-1"]);
  });

  test("handles a Wake-Up Call before enqueueing child execution jobs and publishing Task Status Events", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.wakeUpResult = {
      executionJobs: [makeExecutionJob()],
      taskStatusEvents: [makeTaskStatusEvent("QUEUED")],
    };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const command = makeWakeUpCommand();
    const result = await orchestrator.handleWakeUpCall(command);

    assert.equal(result.ok, true);
    assert.deepEqual(result.value, repository.wakeUpResult);
    assert.deepEqual(repository.wakeUpCommands, [command]);
    assert.deepEqual(sideEffects, [
      "wake-up~task-run-1",
      "enqueue:task-run~task-run-1~attempt~0~execute",
      "publish:workflow-1:task-run-1",
    ]);
  });

  test("handles a Wake-Up Call with no child work without enqueueing or publishing", async () => {
    const sideEffects: string[] = [];
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository: new FakeRepository(sideEffects),
    });

    const result = await orchestrator.handleWakeUpCall(makeWakeUpCommand());

    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
      executionJobs: [],
      taskStatusEvents: [],
    });
    assert.deepEqual(sideEffects, ["wake-up~task-run-1"]);
  });

  test("returns Wake-Up Call repository failures without enqueueing or publishing", async () => {
    const sideEffects: string[] = [];
    const repository = new FakeRepository(sideEffects);
    repository.wakeUpError = new Error("database unavailable");
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const result = await orchestrator.handleWakeUpCall(makeWakeUpCommand());

    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "WorkflowRuntimeCommitError");
    assert.equal(result.error.committed, false);
    assert.equal(result.error.cause, repository.wakeUpError);
    assert.deepEqual(sideEffects, ["wake-up~attempt:task-run-1"]);
  });

  test("returns Wake-Up Call enqueue failures as committed post-commit failures without publishing", async () => {
    const sideEffects: string[] = [];
    const queue = new FakeQueue(sideEffects);
    queue.enqueueError = new Error("queue unavailable");
    const repository = new FakeRepository(sideEffects);
    repository.wakeUpResult = {
      executionJobs: [makeExecutionJob()],
      taskStatusEvents: [makeTaskStatusEvent("QUEUED")],
    };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher: new FakeEventPublisher(sideEffects),
      queue,
      repository,
    });

    const result = await orchestrator.handleWakeUpCall(makeWakeUpCommand());

    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "WorkflowRuntimePostCommitSideEffectError");
    assert.equal(result.error.committed, true);
    assert.equal(result.error.sideEffect, "enqueue-execution-jobs");
    assert.equal(result.error.cause, queue.enqueueError);
    assert.deepEqual(sideEffects, ["wake-up~task-run-1", "enqueue-attempt"]);
  });

  test("returns Wake-Up Call publish failures as committed post-commit failures after enqueueing", async () => {
    const sideEffects: string[] = [];
    const eventPublisher = new FakeEventPublisher(sideEffects);
    eventPublisher.publishError = new Error("pubsub unavailable");
    const repository = new FakeRepository(sideEffects);
    repository.wakeUpResult = {
      executionJobs: [makeExecutionJob()],
      taskStatusEvents: [makeTaskStatusEvent("QUEUED")],
    };
    const orchestrator = createWorkflowRuntimeOrchestrator({
      eventPublisher,
      queue: new FakeQueue(sideEffects),
      repository,
    });

    const result = await orchestrator.handleWakeUpCall(makeWakeUpCommand());

    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "WorkflowRuntimePostCommitSideEffectError");
    assert.equal(result.error.committed, true);
    assert.equal(result.error.sideEffect, "publish-task-status-events");
    assert.equal(result.error.cause, eventPublisher.publishError);
    assert.deepEqual(sideEffects, [
      "wake-up~task-run-1",
      "enqueue:task-run~task-run-1~attempt~0~execute",
      "publish-attempt:workflow-1",
    ]);
  });
});

function makeNode(kind: Parameters<typeof createWorkflowNode>[0], id: string) {
  const node = { ...createWorkflowNode(kind, 0), id };

  return node.kind === "prompt"
    ? {
        ...node,
        prompt: "{{topic}}",
        variables: [{ key: "topic", label: "Topic" }],
      }
    : node;
}

function makeDocument(): WorkflowDocument {
  return {
    edges: [
      {
        id: "topic-to-prompt",
        source: "topic",
        sourceHandle: "text",
        target: "prompt",
        targetHandle: "topic",
      },
      {
        id: "prompt-to-script",
        source: "prompt",
        sourceHandle: "text",
        target: "script",
        targetHandle: "prompt",
      },
    ],
    nodes: [
      makeNode("list", "topic"),
      makeNode("prompt", "prompt"),
      makeNode("llmGenerator", "script"),
    ],
    version: WORKFLOW_DOCUMENT_VERSION,
  };
}

function nextId(prefix: string) {
  let index = 0;

  return () => `${prefix}-${++index}`;
}

function runScriptInput() {
  return {
    command: { type: "run-target", targetNodeIds: ["script"] } as const,
    document: makeDocument(),
    latestNodeExecutions: [
      { id: "topic-execution", nodeId: "topic" },
      { id: "prompt-execution", nodeId: "prompt" },
    ],
    latestTaskRuns: [
      {
        attempt: 0,
        id: "topic-task",
        itemIndex: 0,
        nodeExecutionId: "topic-execution",
        status: "APPROVED" as const,
      },
      {
        attempt: 0,
        id: "prompt-task",
        itemIndex: 0,
        nodeExecutionId: "prompt-execution",
        status: "APPROVED" as const,
      },
    ],
    ownerId: "owner-1",
    workflowId: "workflow-1",
  };
}

function makeTaskStatusEvent(
  status: TaskStatusEvent["status"],
): TaskStatusEvent {
  return {
    attempt: 0,
    itemIndex: 0,
    nodeExecutionId: "node-execution-1",
    status,
    taskRunId: "task-run-1",
  };
}

function makeWakeUpJob(): WorkflowRuntimeWakeUpJobPayload {
  return {
    jobId: "wake-up~task-run-1",
    ownerUserId: "owner-1",
    parentTaskRunId: "task-run-1",
    workflowId: "workflow-1",
  };
}

function makeExecutionJob(): WorkflowRuntimeExecutionJobPayload {
  return {
    attempt: 0,
    itemIndex: 0,
    jobId: "task-run~task-run-1~attempt~0~execute",
    nodeExecutionId: "node-execution-1",
    ownerUserId: "owner-1",
    taskRunId: "task-run-1",
    workflowId: "workflow-1",
  };
}

function makeWakeUpCommand(): WakeUpTaskRunChildrenRepositoryCommand & {
  readonly workflowId: string;
} {
  return {
    ownerUserId: "owner-1",
    settledParentTaskRunId: "task-run-1",
    workflowId: "workflow-1",
  };
}

function makeCompletionCommand(): SettleWorkerCompletionCommand {
  return {
    attempt: 0,
    finalCostCredits: 2,
    generatedAsset: {
      assetId: "asset-1",
      contentType: "text/plain",
      fileName: "script.txt",
      kind: "text",
      sizeBytes: 11,
      storageProvider: "inline",
      text: "hello world",
    },
    ownerUserId: "owner-1",
    reviewRequired: false,
    taskRunId: "task-run-1",
    workflowId: "workflow-1",
  };
}

function makeFailureCommand(): SettleWorkerFailureCommand {
  return {
    attempt: 0,
    failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
    finalCostCredits: 1,
    ownerUserId: "owner-1",
    taskRunId: "task-run-1",
    workflowId: "workflow-1",
  };
}

function makeReviewDecisionCommand(): ReviewTaskRunDecisionCommand {
  return {
    attempt: 0,
    ownerUserId: "owner-1",
    taskRunId: "task-run-1",
    workflowId: "workflow-1",
  };
}

function makeRejectTaskRunCommand(): RejectTaskRunCommand {
  return makeReviewDecisionCommand();
}

class FakeRepository {
  commitError: Error | null = null;
  commitResultOverride: {
    readonly executionJobs: readonly WorkflowRuntimeExecutionJobPayload[];
    readonly taskStatusEvents: readonly TaskStatusEvent[];
    readonly wakeUpJobs: readonly WorkflowRuntimeWakeUpJobPayload[];
  } | null = null;
  readonly committedPlans: WorkflowRunPlan[] = [];
  completionResult:
    | {
        readonly event: TaskStatusEvent;
        readonly settled: true;
        readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload | null;
      }
    | { readonly settled: false } = { settled: false };
  readonly completionCommands: SettleWorkerCompletionCommand[] = [];
  failureResult:
    | {
        readonly event: TaskStatusEvent;
        readonly settled: true;
        readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload;
      }
    | { readonly settled: false } = { settled: false };
  readonly failureCommands: SettleWorkerFailureCommand[] = [];
  approveResult:
    | {
        readonly decided: true;
        readonly event: TaskStatusEvent;
        readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload;
      }
    | { readonly decided: false } = { decided: false };
  readonly approveCommands: ReviewTaskRunDecisionCommand[] = [];
  cancelResult:
    | {
        readonly decided: true;
        readonly event: TaskStatusEvent;
        readonly wakeUpJob: WorkflowRuntimeWakeUpJobPayload;
      }
    | { readonly decided: false } = { decided: false };
  readonly cancelCommands: ReviewTaskRunDecisionCommand[] = [];
  rejectResult:
    | {
        readonly rejected: true;
        readonly executionJob: WorkflowRuntimeExecutionJobPayload | null;
        readonly taskStatusEvents: readonly TaskStatusEvent[];
      }
    | { readonly rejected: false } = { rejected: false };
  readonly rejectCommands: (RejectTaskRunCommand & {
    readonly newTaskRunId: string;
  })[] = [];
  wakeUpResult: WakeUpTaskRunChildrenRepositoryResult = {
    executionJobs: [],
    taskStatusEvents: [],
  };
  wakeUpError: Error | null = null;
  readonly wakeUpCommands: WakeUpTaskRunChildrenRepositoryCommand[] = [];

  constructor(private readonly sideEffects: string[]) {}

  async commitWorkflowRunPlan(plan: WorkflowRunPlan) {
    if (this.commitError) {
      this.sideEffects.push("commit-attempt");
      throw this.commitError;
    }

    this.committedPlans.push(plan);
    this.sideEffects.push(
      `commit:${plan.taskRunsToCreate.map((taskRun) => taskRun.id).join(",")}`,
    );
    if (this.commitResultOverride) {
      return this.commitResultOverride;
    }

    return {
      executionJobs: plan.taskRunsToCreate.flatMap((taskRun) =>
        taskRun.status === "QUEUED"
          ? [
              {
                attempt: taskRun.attempt,
                itemIndex: taskRun.itemIndex,
                jobId: `task-run~${taskRun.id}~attempt~${taskRun.attempt}~execute`,
                nodeExecutionId: taskRun.nodeExecutionId,
                ownerUserId: "owner-1",
                taskRunId: taskRun.id,
                workflowId: "workflow-1",
              } satisfies WorkflowRuntimeExecutionJobPayload,
            ]
          : [],
      ),
      taskStatusEvents: plan.taskRunsToCreate.map(
        (taskRun) =>
          ({
            attempt: taskRun.attempt,
            itemIndex: taskRun.itemIndex,
            nodeExecutionId: taskRun.nodeExecutionId,
            status: taskRun.status,
            taskRunId: taskRun.id,
          }) satisfies TaskStatusEvent,
      ),
      wakeUpJobs: [],
    };
  }

  async settleTaskRunCompletion(command: SettleWorkerCompletionCommand) {
    this.completionCommands.push(command);
    this.sideEffects.push(`settle-completion:${command.taskRunId}`);

    return this.completionResult;
  }

  async settleTaskRunFailure(command: SettleWorkerFailureCommand) {
    this.failureCommands.push(command);
    this.sideEffects.push(`settle-failure:${command.taskRunId}`);

    return this.failureResult;
  }

  async approveTaskRun(command: ReviewTaskRunDecisionCommand) {
    this.approveCommands.push(command);
    this.sideEffects.push(`approve:${command.taskRunId}`);

    return this.approveResult;
  }

  async cancelTaskRun(command: ReviewTaskRunDecisionCommand) {
    this.cancelCommands.push(command);
    this.sideEffects.push(`cancel:${command.taskRunId}`);

    return this.cancelResult;
  }

  async rejectTaskRunAndCreateRegeneration(
    command: RejectTaskRunCommand & { readonly newTaskRunId: string },
  ) {
    this.rejectCommands.push(command);
    this.sideEffects.push(`reject:${command.taskRunId}`);

    return this.rejectResult;
  }

  async wakeUpTaskRunChildren(command: WakeUpTaskRunChildrenRepositoryCommand) {
    this.wakeUpCommands.push(command);
    if (this.wakeUpError) {
      this.sideEffects.push(
        `wake-up~attempt:${command.settledParentTaskRunId}`,
      );
      throw this.wakeUpError;
    }

    this.sideEffects.push(`wake-up~${command.settledParentTaskRunId}`);

    return this.wakeUpResult;
  }
}

class FakeQueue {
  enqueueError: Error | null = null;
  enqueueWakeUpError: Error | null = null;

  constructor(private readonly sideEffects: string[]) {}

  async enqueueExecutionJobs(
    jobs: readonly WorkflowRuntimeExecutionJobPayload[],
  ) {
    if (this.enqueueError) {
      this.sideEffects.push("enqueue-attempt");
      throw this.enqueueError;
    }

    for (const job of jobs) {
      this.sideEffects.push(`enqueue:${job.jobId}`);
    }
  }

  async enqueueWakeUpJobs(jobs: readonly WorkflowRuntimeWakeUpJobPayload[]) {
    if (this.enqueueWakeUpError) {
      this.sideEffects.push("enqueue-wake-up~attempt");
      throw this.enqueueWakeUpError;
    }

    for (const job of jobs) {
      this.sideEffects.push(`enqueue-wake-up~${job.jobId}`);
    }
  }
}

class FakeEventPublisher {
  publishError: Error | null = null;

  constructor(private readonly sideEffects: string[]) {}

  async publishTaskStatusEvents(
    workflowId: string,
    events: readonly TaskStatusEvent[],
  ) {
    if (this.publishError) {
      this.sideEffects.push(`publish-attempt:${workflowId}`);
      throw this.publishError;
    }

    for (const event of events) {
      this.sideEffects.push(`publish:${workflowId}:${event.taskRunId}`);
    }
  }
}
