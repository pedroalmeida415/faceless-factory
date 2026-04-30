import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createWorkflowNode,
  toWorkflowDefinitionGraphDocument,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import type { TaskRunStatus } from "~/lib/workflow-runtime/domain/task-run-state";
import { planWorkflowRun } from "~/lib/workflow-runtime/planning/workflow-run-planner";

function makeNode(kind: Parameters<typeof createWorkflowNode>[0], id: string) {
  const node = {
    ...createWorkflowNode(kind, 0),
    id,
  };

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
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes: [
      makeNode("list", "topic"),
      makeNode("prompt", "prompt"),
      makeNode("llmGenerator", "script"),
    ],
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
  };
}

function makeGeneratorInputDocument(): WorkflowDocument {
  const asset = makeNode("asset", "reference");
  return {
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes: [
      makeNode("prompt", "prompt"),
      asset.kind === "asset"
        ? { ...asset, assetKind: "image" as const }
        : asset,
      makeNode("imageGenerator", "image"),
    ],
    edges: [
      {
        id: "prompt-to-image",
        source: "prompt",
        sourceHandle: "text",
        target: "image",
        targetHandle: "prompt",
      },
      {
        id: "reference-to-image",
        source: "reference",
        sourceHandle: "asset",
        target: "image",
        targetHandle: "image-input-0",
      },
    ],
  };
}

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
) {
  assert.equal(result.ok, true);
  return result.value;
}

function latestNodeExecution(id: string, nodeId: string) {
  return { id, nodeId };
}

function latestTaskRun(input: {
  id: string;
  nodeExecutionId: string;
  itemIndex?: number;
  attempt?: number;
  status: TaskRunStatus;
}) {
  return {
    attempt: input.attempt ?? 0,
    id: input.id,
    itemIndex: input.itemIndex ?? 0,
    nodeExecutionId: input.nodeExecutionId,
    status: input.status,
  };
}

describe("WorkflowRunPlanner", () => {
  test("run-target plans the full upstream closure and starts only satisfied roots as Queued", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-target", targetNodeIds: ["script"] },
        document: makeDocument(),
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.nodeExecutionsToCreate.map((execution) => execution.nodeId),
      ["topic", "prompt", "script"],
    );
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        attempt: taskRun.attempt,
        itemIndex: taskRun.itemIndex,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        { attempt: 0, itemIndex: 0, nodeId: "topic", status: "QUEUED" },
        {
          attempt: 0,
          itemIndex: 0,
          nodeId: "prompt",
          status: "WAITING_UPSTREAM",
        },
        {
          attempt: 0,
          itemIndex: 0,
          nodeId: "script",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
    assert.deepEqual(
      plan.taskDependenciesToCreate.map((dependency) => ({
        childNodeId: dependency.childNodeId,
        childTaskRunId: dependency.childTaskRunId,
        parentItemIndex: dependency.parentItemIndex,
        parentNodeExecutionId: dependency.parentNodeExecutionId,
        parentNodeId: dependency.parentNodeId,
      })),
      [
        {
          childNodeId: "prompt",
          childTaskRunId: "planned-task-run-2",
          parentItemIndex: 0,
          parentNodeExecutionId: "planned-node-execution-1",
          parentNodeId: "topic",
        },
        {
          childNodeId: "script",
          childTaskRunId: "planned-task-run-3",
          parentItemIndex: 0,
          parentNodeExecutionId: "planned-node-execution-2",
          parentNodeId: "prompt",
        },
      ],
    );
  });

  test("carries estimated credit costs onto planned Task Runs", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-target", targetNodeIds: ["script"] },
        document: makeDocument(),
        estimatedCreditCostByNodeId: { prompt: 3, script: 8, topic: 1 },
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        estimatedCreditCost: taskRun.estimatedCreditCost,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        { estimatedCreditCost: 1, nodeId: "topic", status: "QUEUED" },
        {
          estimatedCreditCost: 3,
          nodeId: "prompt",
          status: "WAITING_UPSTREAM",
        },
        {
          estimatedCreditCost: 8,
          nodeId: "script",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
  });

  test("carries the target node configuration snapshot onto planned Task Runs", () => {
    const document = makeDocument();
    const definition = toWorkflowDefinitionGraphDocument(document);
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-target", targetNodeIds: ["script"] },
        document,
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        nodeId: taskRun.nodeId,
        targetNodeConfig: taskRun.targetNodeConfig,
      })),
      [
        { nodeId: "topic", targetNodeConfig: definition.nodes[0] },
        { nodeId: "prompt", targetNodeConfig: definition.nodes[1] },
        { nodeId: "script", targetNodeConfig: definition.nodes[2] },
      ],
    );
  });

  test("run-target uses injected plan identities consistently across Task Dependencies", () => {
    let nodeExecutionIndex = 0;
    let taskRunIndex = 0;

    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-target", targetNodeIds: ["script"] },
        createNodeExecutionId: () => `node-execution-${++nodeExecutionIndex}`,
        createTaskRunId: () => `task-run-${++taskRunIndex}`,
        document: makeDocument(),
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.nodeExecutionsToCreate.map((execution) => execution.id),
      ["node-execution-1", "node-execution-2", "node-execution-3"],
    );
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => taskRun.id),
      ["task-run-1", "task-run-2", "task-run-3"],
    );
    assert.deepEqual(
      plan.taskDependenciesToCreate.map((dependency) => ({
        childNodeExecutionId: dependency.childNodeExecutionId,
        childNodeId: dependency.childNodeId,
        childTaskRunId: dependency.childTaskRunId,
        parentNodeExecutionId: dependency.parentNodeExecutionId,
        parentNodeId: dependency.parentNodeId,
      })),
      [
        {
          childNodeExecutionId: "node-execution-2",
          childNodeId: "prompt",
          childTaskRunId: "task-run-2",
          parentNodeExecutionId: "node-execution-1",
          parentNodeId: "topic",
        },
        {
          childNodeExecutionId: "node-execution-3",
          childNodeId: "script",
          childTaskRunId: "task-run-3",
          parentNodeExecutionId: "node-execution-2",
          parentNodeId: "prompt",
        },
      ],
    );
  });

  test("plans dependency address handles for prompt and media generator inputs", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-target", targetNodeIds: ["image"] },
        document: makeGeneratorInputDocument(),
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.taskDependenciesToCreate
        .filter((dependency) => dependency.childNodeId === "image")
        .map((dependency) => ({
          parentNodeId: dependency.parentNodeId,
          sourceHandle: dependency.sourceHandle,
          targetHandle: dependency.targetHandle,
          targetNodeId: dependency.targetNodeId,
        })),
      [
        {
          parentNodeId: "prompt",
          sourceHandle: "text",
          targetHandle: "prompt",
          targetNodeId: "image",
        },
        {
          parentNodeId: "reference",
          sourceHandle: "asset",
          targetHandle: "image-input-0",
          targetNodeId: "image",
        },
      ],
    );
  });

  test("run-target reuses latest upstream Node Executions and creates only the missing target batch", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-target", targetNodeIds: ["script"] },
        document: makeDocument(),
        latestNodeExecutions: [
          latestNodeExecution("topic-execution", "topic"),
          latestNodeExecution("prompt-execution", "prompt"),
        ],
        latestTaskRuns: [
          latestTaskRun({
            id: "topic-task",
            nodeExecutionId: "topic-execution",
            status: "APPROVED",
          }),
          latestTaskRun({
            id: "prompt-task",
            nodeExecutionId: "prompt-execution",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(plan.nodeExecutionsToReuse, [
      { id: "topic-execution", nodeId: "topic" },
      { id: "prompt-execution", nodeId: "prompt" },
    ]);
    assert.deepEqual(plan.nodeExecutionsToCreate, [
      {
        id: "planned-node-execution-1",
        nodeId: "script",
        ownerId: "owner-1",
        workflowId: "workflow-1",
      },
    ]);
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        nodeExecutionId: taskRun.nodeExecutionId,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        {
          nodeExecutionId: "planned-node-execution-1",
          nodeId: "script",
          status: "QUEUED",
        },
      ],
    );
  });

  test("run-target creates next upstream attempts for recoverable failed latest slots", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-target", targetNodeIds: ["script"] },
        document: makeDocument(),
        latestNodeExecutions: [
          latestNodeExecution("topic-execution", "topic"),
          latestNodeExecution("prompt-execution", "prompt"),
        ],
        latestTaskRuns: [
          latestTaskRun({
            attempt: 2,
            id: "topic-task",
            nodeExecutionId: "topic-execution",
            status: "FAILED",
          }),
          latestTaskRun({
            id: "prompt-task",
            nodeExecutionId: "prompt-execution",
            status: "UPSTREAM_FAILED",
          }),
        ],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        attempt: taskRun.attempt,
        nodeExecutionId: taskRun.nodeExecutionId,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        {
          attempt: 3,
          nodeExecutionId: "topic-execution",
          nodeId: "topic",
          status: "QUEUED",
        },
        {
          attempt: 1,
          nodeExecutionId: "prompt-execution",
          nodeId: "prompt",
          status: "WAITING_UPSTREAM",
        },
        {
          attempt: 0,
          nodeExecutionId: "planned-node-execution-1",
          nodeId: "script",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
  });

  test("run-target does not duplicate active upstream attempts", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-target", targetNodeIds: ["script"] },
        document: makeDocument(),
        latestNodeExecutions: [
          latestNodeExecution("topic-execution", "topic"),
          latestNodeExecution("prompt-execution", "prompt"),
        ],
        latestTaskRuns: [
          latestTaskRun({
            id: "topic-task",
            nodeExecutionId: "topic-execution",
            status: "RUNNING",
          }),
          latestTaskRun({
            id: "prompt-task",
            nodeExecutionId: "prompt-execution",
            status: "WAITING_UPSTREAM",
          }),
        ],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => taskRun.nodeId),
      ["script"],
    );
    assert.equal(plan.taskRunsToCreate[0]?.status, "WAITING_UPSTREAM");
  });

  test("run-target rejects when the target latest Node Execution has active Task Runs", () => {
    const result = planWorkflowRun({
      command: { type: "run-target", targetNodeIds: ["script"] },
      document: makeDocument(),
      latestNodeExecutions: [latestNodeExecution("script-execution", "script")],
      latestTaskRuns: [
        latestTaskRun({
          id: "script-task",
          nodeExecutionId: "script-execution",
          status: "PENDING_REVIEW",
        }),
      ],
      ownerId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
      _tag: "WorkflowRunPlannerError",
      message:
        "Cannot run target script because its latest Node Execution has active Task Runs.",
    });
  });

  test("run-target creates a new target batch when the latest target execution is terminal and reuses approved upstream", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-target", targetNodeIds: ["script"] },
        document: makeDocument(),
        latestNodeExecutions: [
          latestNodeExecution("topic-execution", "topic"),
          latestNodeExecution("prompt-execution", "prompt"),
          latestNodeExecution("script-execution", "script"),
        ],
        latestTaskRuns: [
          latestTaskRun({
            id: "topic-task",
            nodeExecutionId: "topic-execution",
            status: "APPROVED",
          }),
          latestTaskRun({
            id: "prompt-task",
            nodeExecutionId: "prompt-execution",
            status: "APPROVED",
          }),
          latestTaskRun({
            attempt: 3,
            id: "script-task",
            nodeExecutionId: "script-execution",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(plan.nodeExecutionsToReuse, [
      { id: "topic-execution", nodeId: "topic" },
      { id: "prompt-execution", nodeId: "prompt" },
    ]);
    assert.deepEqual(plan.nodeExecutionsToCreate, [
      {
        id: "planned-node-execution-1",
        nodeId: "script",
        ownerId: "owner-1",
        workflowId: "workflow-1",
      },
    ]);
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        attempt: taskRun.attempt,
        nodeExecutionId: taskRun.nodeExecutionId,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        {
          attempt: 0,
          nodeExecutionId: "planned-node-execution-1",
          nodeId: "script",
          status: "QUEUED",
        },
      ],
    );
  });

  test("rerun-node creates a new Node Execution with fresh Attempt 0 Task Runs", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "rerun-node", nodeId: "prompt" },
        document: makeDocument(),
        latestNodeExecutions: [
          latestNodeExecution("prompt-execution", "prompt"),
        ],
        latestTaskRuns: [
          latestTaskRun({
            attempt: 4,
            id: "prompt-task",
            itemIndex: 0,
            nodeExecutionId: "prompt-execution",
            status: "FAILED",
          }),
        ],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { prompt: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(plan.nodeExecutionsToCreate, [
      {
        id: "planned-node-execution-1",
        nodeId: "prompt",
        ownerId: "owner-1",
        workflowId: "workflow-1",
      },
    ]);
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        attempt: taskRun.attempt,
        itemIndex: taskRun.itemIndex,
        status: taskRun.status,
      })),
      [
        { attempt: 0, itemIndex: 0, status: "WAITING_UPSTREAM" },
        { attempt: 0, itemIndex: 1, status: "WAITING_UPSTREAM" },
      ],
    );
  });

  test("rerun-node rejects when the latest Node Execution has active Task Runs", () => {
    const result = planWorkflowRun({
      command: { type: "rerun-node", nodeId: "prompt" },
      document: makeDocument(),
      latestNodeExecutions: [latestNodeExecution("prompt-execution", "prompt")],
      latestTaskRuns: [
        latestTaskRun({
          id: "prompt-task",
          nodeExecutionId: "prompt-execution",
          status: "QUEUED",
        }),
      ],
      ownerId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
      _tag: "WorkflowRunPlannerError",
      message:
        "Cannot rerun node prompt because its latest Node Execution has active Task Runs.",
    });
  });

  test("regenerate-item preserves the Node Execution and creates next attempts for selected Item Indexes", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: {
          itemIndexes: [1],
          nodeExecutionId: "topic-execution",
          type: "regenerate-item",
        },
        document: makeDocument(),
        latestNodeExecutions: [latestNodeExecution("topic-execution", "topic")],
        latestTaskRuns: [
          latestTaskRun({
            attempt: 2,
            id: "topic-task-0",
            itemIndex: 0,
            nodeExecutionId: "topic-execution",
            status: "APPROVED",
          }),
          latestTaskRun({
            attempt: 3,
            id: "topic-task-1",
            itemIndex: 1,
            nodeExecutionId: "topic-execution",
            status: "CANCELLED",
          }),
        ],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(plan.nodeExecutionsToCreate, []);
    assert.deepEqual(plan.nodeExecutionsToReuse, [
      { id: "topic-execution", nodeId: "topic" },
    ]);
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        attempt: taskRun.attempt,
        itemIndex: taskRun.itemIndex,
        nodeExecutionId: taskRun.nodeExecutionId,
        nodeId: taskRun.nodeId,
      })),
      [
        {
          attempt: 4,
          itemIndex: 1,
          nodeExecutionId: "topic-execution",
          nodeId: "topic",
        },
      ],
    );
  });

  test("regenerate-item creates dependencies to latest approved parent executions before queueing the next Attempt", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: {
          itemIndexes: [0],
          nodeExecutionId: "prompt-execution",
          type: "regenerate-item",
        },
        document: makeDocument(),
        latestNodeExecutions: [
          latestNodeExecution("topic-execution", "topic"),
          latestNodeExecution("prompt-execution", "prompt"),
        ],
        latestTaskRuns: [
          latestTaskRun({
            attempt: 0,
            id: "topic-task-0",
            nodeExecutionId: "topic-execution",
            status: "APPROVED",
          }),
          latestTaskRun({
            attempt: 2,
            id: "prompt-task-0",
            nodeExecutionId: "prompt-execution",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(plan.nodeExecutionsToReuse, [
      { id: "prompt-execution", nodeId: "prompt" },
      { id: "topic-execution", nodeId: "topic" },
    ]);
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        attempt: taskRun.attempt,
        id: taskRun.id,
        nodeExecutionId: taskRun.nodeExecutionId,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        {
          attempt: 3,
          id: "planned-task-run-1",
          nodeExecutionId: "prompt-execution",
          nodeId: "prompt",
          status: "QUEUED",
        },
      ],
    );
    assert.deepEqual(plan.taskDependenciesToCreate, [
      {
        childNodeExecutionId: "prompt-execution",
        childNodeId: "prompt",
        childTaskRunId: "planned-task-run-1",
        parentItemIndex: 0,
        parentNodeExecutionId: "topic-execution",
        parentNodeId: "topic",
        sourceHandle: "text",
        targetHandle: "topic",
        targetNodeId: "prompt",
      },
    ]);
  });

  test("regenerate-item rejects when a selected latest Attempt is active", () => {
    const result = planWorkflowRun({
      command: {
        itemIndexes: [0],
        nodeExecutionId: "prompt-execution",
        type: "regenerate-item",
      },
      document: makeDocument(),
      latestNodeExecutions: [latestNodeExecution("prompt-execution", "prompt")],
      latestTaskRuns: [
        latestTaskRun({
          id: "prompt-task",
          itemIndex: 0,
          nodeExecutionId: "prompt-execution",
          status: "RUNNING",
        }),
      ],
      ownerId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
      _tag: "WorkflowRunPlannerError",
      message:
        "Cannot regenerate item 0 for Node Execution prompt-execution because the latest Attempt is active.",
    });
  });
});
