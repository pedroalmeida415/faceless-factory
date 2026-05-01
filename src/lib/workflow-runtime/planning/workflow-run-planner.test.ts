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

function makeOutputReorderDependencyDocument(): WorkflowDocument {
  const reorder = makeNode("outputReorder", "reorder");
  return {
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes: [
      makeNode("llmGenerator", "source"),
      reorder.kind === "outputReorder"
        ? {
            ...reorder,
            mode: "manual" as const,
            order: [1, 0],
            valueType: "text" as const,
          }
        : reorder,
      makeNode("llmGenerator", "script"),
    ],
    edges: [
      {
        id: "source-to-reorder",
        source: "source",
        sourceHandle: "text",
        target: "reorder",
        targetHandle: "input",
      },
      {
        id: "reorder-to-script",
        source: "reorder",
        sourceHandle: "output",
        target: "script",
        targetHandle: "prompt",
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
      ["script"],
    );
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        attempt: taskRun.attempt,
        itemIndex: taskRun.itemIndex,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        {
          attempt: 0,
          itemIndex: 0,
          nodeId: "script",
          status: "QUEUED",
        },
      ],
    );
    assert.deepEqual(plan.taskDependenciesToCreate, []);
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
        {
          estimatedCreditCost: 8,
          nodeId: "script",
          status: "QUEUED",
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
      [{ nodeId: "script", targetNodeConfig: definition.nodes[2] }],
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
      ["node-execution-1"],
    );
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => taskRun.id),
      ["task-run-1"],
    );
    assert.deepEqual(plan.taskDependenciesToCreate, []);
  });

  test("does not create Task Dependencies for static prompt and asset inputs", () => {
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
      [],
    );
  });

  test("maps output-reorder item indexes onto provider-backed Task Dependencies", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-target", targetNodeIds: ["script"] },
        document: makeOutputReorderDependencyDocument(),
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { script: 2, source: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.taskDependenciesToCreate.map((dependency) => ({
        childNodeId: dependency.childNodeId,
        childTaskRunId: dependency.childTaskRunId,
        parentItemIndex: dependency.parentItemIndex,
        parentNodeId: dependency.parentNodeId,
        sourceHandle: dependency.sourceHandle,
        targetHandle: dependency.targetHandle,
      })),
      [
        {
          childNodeId: "script",
          childTaskRunId: "planned-task-run-3",
          parentItemIndex: 1,
          parentNodeId: "source",
          sourceHandle: "text",
          targetHandle: "prompt",
        },
        {
          childNodeId: "script",
          childTaskRunId: "planned-task-run-4",
          parentItemIndex: 0,
          parentNodeId: "source",
          sourceHandle: "text",
          targetHandle: "prompt",
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

    assert.deepEqual(plan.nodeExecutionsToReuse, []);
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
          attempt: 0,
          nodeExecutionId: "planned-node-execution-1",
          nodeId: "script",
          status: "QUEUED",
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
    assert.equal(plan.taskRunsToCreate[0]?.status, "QUEUED");
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

    assert.deepEqual(plan.nodeExecutionsToReuse, []);
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
        command: { type: "rerun-node", nodeId: "script" },
        document: makeDocument(),
        latestNodeExecutions: [
          latestNodeExecution("script-execution", "script"),
        ],
        latestTaskRuns: [
          latestTaskRun({
            attempt: 4,
            id: "script-task",
            itemIndex: 0,
            nodeExecutionId: "script-execution",
            status: "FAILED",
          }),
        ],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { script: 2 },
        workflowId: "workflow-1",
      }),
    );

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
        itemIndex: taskRun.itemIndex,
        status: taskRun.status,
      })),
      [
        { attempt: 0, itemIndex: 0, status: "QUEUED" },
        { attempt: 0, itemIndex: 1, status: "QUEUED" },
      ],
    );
  });

  test("rerun-node rejects when the latest Node Execution has active Task Runs", () => {
    const result = planWorkflowRun({
      command: { type: "rerun-node", nodeId: "script" },
      document: makeDocument(),
      latestNodeExecutions: [latestNodeExecution("script-execution", "script")],
      latestTaskRuns: [
        latestTaskRun({
          id: "script-task",
          nodeExecutionId: "script-execution",
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
        "Cannot rerun node script because its latest Node Execution has active Task Runs.",
    });
  });

  test("regenerate-item preserves the Node Execution and creates next attempts for selected Item Indexes", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: {
          itemIndexes: [1],
          nodeExecutionId: "script-execution",
          type: "regenerate-item",
        },
        document: makeDocument(),
        latestNodeExecutions: [
          latestNodeExecution("script-execution", "script"),
        ],
        latestTaskRuns: [
          latestTaskRun({
            attempt: 2,
            id: "script-task-0",
            itemIndex: 0,
            nodeExecutionId: "script-execution",
            status: "APPROVED",
          }),
          latestTaskRun({
            attempt: 3,
            id: "script-task-1",
            itemIndex: 1,
            nodeExecutionId: "script-execution",
            status: "CANCELLED",
          }),
        ],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(plan.nodeExecutionsToCreate, []);
    assert.deepEqual(plan.nodeExecutionsToReuse, [
      { id: "script-execution", nodeId: "script" },
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
          nodeExecutionId: "script-execution",
          nodeId: "script",
        },
      ],
    );
  });

  test("regenerate-item creates dependencies to latest approved parent executions before queueing the next Attempt", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: {
          itemIndexes: [0],
          nodeExecutionId: "script-execution",
          type: "regenerate-item",
        },
        document: makeOutputReorderDependencyDocument(),
        latestNodeExecutions: [
          latestNodeExecution("source-execution", "source"),
          latestNodeExecution("script-execution", "script"),
        ],
        latestTaskRuns: [
          latestTaskRun({
            attempt: 0,
            id: "source-task-0",
            itemIndex: 1,
            nodeExecutionId: "source-execution",
            status: "APPROVED",
          }),
          latestTaskRun({
            attempt: 2,
            id: "script-task-0",
            nodeExecutionId: "script-execution",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { script: 2, source: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(plan.nodeExecutionsToReuse, [
      { id: "script-execution", nodeId: "script" },
      { id: "source-execution", nodeId: "source" },
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
          nodeExecutionId: "script-execution",
          nodeId: "script",
          status: "QUEUED",
        },
      ],
    );
    assert.deepEqual(plan.taskDependenciesToCreate, [
      {
        childNodeExecutionId: "script-execution",
        childNodeId: "script",
        childTaskRunId: "planned-task-run-1",
        parentItemIndex: 1,
        parentNodeExecutionId: "source-execution",
        parentNodeId: "source",
        sourceHandle: "text",
        targetHandle: "prompt",
        targetNodeId: "script",
      },
    ]);
  });

  test("regenerate-item rejects when a selected latest Attempt is active", () => {
    const result = planWorkflowRun({
      command: {
        itemIndexes: [0],
        nodeExecutionId: "script-execution",
        type: "regenerate-item",
      },
      document: makeDocument(),
      latestNodeExecutions: [latestNodeExecution("script-execution", "script")],
      latestTaskRuns: [
        latestTaskRun({
          id: "script-task",
          itemIndex: 0,
          nodeExecutionId: "script-execution",
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
        "Cannot regenerate item 0 for Node Execution script-execution because the latest Attempt is active.",
    });
  });
});
