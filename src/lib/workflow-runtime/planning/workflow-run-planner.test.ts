import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  createWorkflowNode,
  toWorkflowDefinitionGraphDocument,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
  type WorkflowDocumentNode,
} from "~/lib/workflow/document";
import type { TaskRunStatus } from "~/lib/workflow-runtime/domain/task-run-state";
import { planWorkflowRun } from "~/lib/workflow-runtime/planning/workflow-run-planner";

function makeNode<K extends Parameters<typeof createWorkflowNode>[0]>(
  kind: K,
  id: string,
): Extract<WorkflowDocumentNode, { kind: K }> {
  const node = {
    ...createWorkflowNode(kind, 0),
    id,
  };

  const configuredNode =
    node.kind === "prompt"
      ? {
          ...node,
          prompt: "{{topic}}",
          variables: [{ key: "topic", label: "Topic" }],
        }
      : node;

  return configuredNode as Extract<WorkflowDocumentNode, { kind: K }>;
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

function makeReviewEnabledUpstreamImageDocument(): WorkflowDocument {
  const upstreamPrompt = makeNode("prompt", "upstream-prompt");
  const upstreamImage = makeNode("imageGenerator", "upstream-image");
  const downstreamPrompt = makeNode("prompt", "downstream-prompt");
  const downstreamImage = makeNode("imageGenerator", "downstream-image");

  return {
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes: [
      upstreamPrompt,
      upstreamImage.kind === "imageGenerator"
        ? { ...upstreamImage, reviewEnabled: true }
        : upstreamImage,
      downstreamPrompt,
      downstreamImage,
    ],
    edges: [
      {
        id: "upstream-prompt-to-image",
        source: "upstream-prompt",
        sourceHandle: "text",
        target: "upstream-image",
        targetHandle: "prompt",
      },
      {
        id: "downstream-prompt-to-image",
        source: "downstream-prompt",
        sourceHandle: "text",
        target: "downstream-image",
        targetHandle: "prompt",
      },
      {
        id: "upstream-to-downstream-image",
        source: "upstream-image",
        sourceHandle: "images",
        target: "downstream-image",
        targetHandle: "image-input-0",
      },
    ],
  };
}

function makeWaitingUpstreamFreezeDocument(): WorkflowDocument {
  const topic = makeNode("list", "topic");
  const prompt = makeNode("prompt", "prompt");
  const reference = makeNode("asset", "reference");
  const source = makeNode("llmGenerator", "source");
  const reorder = makeNode("outputReorder", "reorder");
  const image = makeNode("imageGenerator", "image");
  return {
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes: [
      topic.kind === "list" ? { ...topic, items: ["alpha", "beta"] } : topic,
      prompt.kind === "prompt"
        ? {
            ...prompt,
            prompt: "Paint {{topic}} with frozen lighting",
            variables: [{ key: "topic", label: "Topic" }],
          }
        : prompt,
      reference.kind === "asset"
        ? {
            ...reference,
            assetKind: "image" as const,
            assets: [workflowAsset("asset-reference-frozen")],
          }
        : reference,
      { ...source, config: { maxOutputTokens: 256, temperature: 0.3 } },
      reorder.kind === "outputReorder"
        ? {
            ...reorder,
            mode: "manual" as const,
            order: [1, 0],
            valueType: "text" as const,
          }
        : reorder,
      image.kind === "imageGenerator"
        ? {
            ...image,
            config: { aspectRatio: "16:9" },
            reviewEnabled: true,
          }
        : image,
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
      {
        id: "source-to-reorder",
        source: "source",
        sourceHandle: "text",
        target: "reorder",
        targetHandle: "input",
      },
      {
        id: "reorder-to-image",
        source: "reorder",
        sourceHandle: "output",
        target: "image",
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
  creditCost?: number;
  id: string;
  nodeExecutionId: string;
  nodeId?: string;
  itemIndex?: number;
  attempt?: number;
  status: TaskRunStatus;
}) {
  return {
    attempt: input.attempt ?? 0,
    creditCost: input.creditCost ?? 0,
    id: input.id,
    itemIndex: input.itemIndex ?? 0,
    nodeExecutionId: input.nodeExecutionId,
    nodeId: input.nodeId ?? "script",
    status: input.status,
  };
}

function workflowAsset(id: string) {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    externalUri: null,
    fileName: `${id}.png`,
    id,
    kind: "image" as const,
    mimeType: "image/png",
    model: null,
    size: 123,
    source: "upload" as const,
    storagePath: `uploads/${id}.png`,
    url: `https://cdn.example.com/${id}.png`,
  };
}

describe("WorkflowRunPlanner", () => {
  test("run-node plans the full upstream closure and starts only satisfied roots as Queued", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
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

  test("run-node executes a new review-enabled upstream generator before its downstream child waits", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "downstream-image" },
        createNodeExecutionId: (() => {
          let index = 0;
          return () => `node-execution-${++index}`;
        })(),
        createTaskRunId: (() => {
          let index = 0;
          return () => `task-run-${++index}`;
        })(),
        document: makeReviewEnabledUpstreamImageDocument(),
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        plannedItemCountByNodeId: {
          "downstream-image": 3,
          "upstream-image": 3,
        },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.nodeExecutionsToCreate.map((execution) => ({
        id: execution.id,
        nodeId: execution.nodeId,
      })),
      [
        { id: "node-execution-1", nodeId: "upstream-image" },
        { id: "node-execution-2", nodeId: "downstream-image" },
      ],
    );
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        itemIndex: taskRun.itemIndex,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        { itemIndex: 0, nodeId: "upstream-image", status: "QUEUED" },
        { itemIndex: 1, nodeId: "upstream-image", status: "QUEUED" },
        { itemIndex: 2, nodeId: "upstream-image", status: "QUEUED" },
        {
          itemIndex: 0,
          nodeId: "downstream-image",
          status: "WAITING_UPSTREAM",
        },
        {
          itemIndex: 1,
          nodeId: "downstream-image",
          status: "WAITING_UPSTREAM",
        },
        {
          itemIndex: 2,
          nodeId: "downstream-image",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
    assert.deepEqual(
      plan.taskDependenciesToCreate.map((dependency) => ({
        childTaskRunId: dependency.childTaskRunId,
        parentItemIndex: dependency.parentItemIndex,
        parentNodeExecutionId: dependency.parentNodeExecutionId,
        parentNodeId: dependency.parentNodeId,
      })),
      [
        {
          childTaskRunId: "task-run-4",
          parentItemIndex: 0,
          parentNodeExecutionId: "node-execution-1",
          parentNodeId: "upstream-image",
        },
        {
          childTaskRunId: "task-run-5",
          parentItemIndex: 1,
          parentNodeExecutionId: "node-execution-1",
          parentNodeId: "upstream-image",
        },
        {
          childTaskRunId: "task-run-6",
          parentItemIndex: 2,
          parentNodeExecutionId: "node-execution-1",
          parentNodeId: "upstream-image",
        },
      ],
    );
  });

  test("Run Cost Preview is derived from the same planned Task Runs as creation", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "downstream-image" },
        createNodeExecutionId: (() => {
          let index = 0;
          return () => `node-execution-${++index}`;
        })(),
        createTaskRunId: (() => {
          let index = 0;
          return () => `task-run-${++index}`;
        })(),
        document: makeReviewEnabledUpstreamImageDocument(),
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        plannedItemCountByNodeId: {
          "downstream-image": 2,
          "upstream-image": 2,
        },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.runCostPreview.items.map((item) => ({
        creditCost: item.creditCost,
        debitTiming: item.debitTiming,
        itemIndex: item.itemIndex,
        nodeId: item.nodeId,
        role: item.role,
        source: item.source,
        status: item.status,
        taskRunId: item.taskRunId,
      })),
      plan.taskRunsToCreate.map((taskRun) => ({
        creditCost: taskRun.creditCost,
        debitTiming:
          taskRun.status === "QUEUED"
            ? "queued-immediately"
            : "waiting-upstream",
        itemIndex: taskRun.itemIndex,
        nodeId: taskRun.nodeId,
        role: taskRun.nodeId === "downstream-image" ? "target" : "upstream",
        source: "planned",
        status: taskRun.status,
        taskRunId: taskRun.id,
      })),
    );
    assert.deepEqual(
      plan.runCostPreview.queuedImmediate.items.map((item) => item.taskRunId),
      ["task-run-1", "task-run-2"],
    );
    assert.deepEqual(
      plan.runCostPreview.waitingUpstream.items.map((item) => item.taskRunId),
      ["task-run-3", "task-run-4"],
    );
    assert.equal(
      plan.runCostPreview.newCostTotal,
      plan.taskRunsToCreate.reduce(
        (total, taskRun) => total + taskRun.creditCost,
        0,
      ),
    );
    assert.equal(
      plan.runCostPreview.immediateDebitTotal,
      plan.taskRunsToCreate
        .filter((taskRun) => taskRun.status === "QUEUED")
        .reduce((total, taskRun) => total + taskRun.creditCost, 0),
    );
  });

  test("Run Cost Preview itemizes active upstream Task Runs but excludes them from new-cost totals", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "downstream-image" },
        createNodeExecutionId: () => "downstream-execution-new",
        createTaskRunId: () => "downstream-task-new",
        document: makeReviewEnabledUpstreamImageDocument(),
        latestNodeExecutions: [
          latestNodeExecution("upstream-execution", "upstream-image"),
        ],
        latestTaskRuns: [
          latestTaskRun({
            creditCost: 7,
            id: "upstream-task-active",
            nodeExecutionId: "upstream-execution",
            nodeId: "upstream-image",
            status: "PENDING_REVIEW",
          }),
        ],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.runCostPreview.items.map((item) => ({
        creditCost: item.creditCost,
        debitTiming: item.debitTiming,
        nodeId: item.nodeId,
        role: item.role,
        source: item.source,
        status: item.status,
        taskRunId: item.taskRunId,
      })),
      [
        {
          creditCost: 7,
          debitTiming: "excluded-existing",
          nodeId: "upstream-image",
          role: "upstream",
          source: "stored",
          status: "PENDING_REVIEW",
          taskRunId: "upstream-task-active",
        },
        {
          creditCost: plan.taskRunsToCreate[0]?.creditCost,
          debitTiming: "waiting-upstream",
          nodeId: "downstream-image",
          role: "target",
          source: "planned",
          status: "WAITING_UPSTREAM",
          taskRunId: "downstream-task-new",
        },
      ],
    );
    assert.equal(plan.runCostPreview.excludedExisting.totalCreditCost, 7);
    assert.equal(
      plan.runCostPreview.newCostTotal,
      plan.taskRunsToCreate[0]?.creditCost,
    );
    assert.equal(plan.runCostPreview.immediateDebitTotal, 0);
  });

  test("assigns immutable credit costs from the Pricing Catalog onto planned Task Runs", () => {
    const document = makeDocument();
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        document: {
          ...document,
          nodes: document.nodes.map((node) =>
            node.id === "script" ? { ...node, creditCost: 999 } : node,
          ) as WorkflowDocument["nodes"],
        },
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        creditCost: taskRun.creditCost,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        {
          creditCost: 1,
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
        command: { type: "run-node", nodeId: "script" },
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

  test("materializes direct queued Task Run input snapshots before persistence", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        createNodeExecutionId: () => "node-execution-script",
        createTaskRunId: () => "task-run-script",
        document: makeDocument(),
        documentRevision: 42,
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    const snapshot = plan.taskRunsToCreate[0]?.inputSnapshot;
    assert.equal(snapshot?.taskRunId, "task-run-script");
    assert.equal(snapshot?.nodeExecutionId, "node-execution-script");
    assert.equal(snapshot?.itemIndex, 0);
    assert.equal(snapshot?.attempt, 0);
    assert.equal(snapshot?.documentRevision, 42);
    assert.equal(
      snapshot?.idempotencyKey,
      "task_run:task-run-script:attempt:0",
    );
    assert.equal(snapshot?.providerInput.kind, "llm-generation-request");
    assert.equal(
      snapshot?.providerInput.kind === "llm-generation-request"
        ? snapshot.providerInput.request.prompt
        : null,
      "",
    );
    assert.deepEqual(snapshot?.resolvedParentTaskRuns, []);
    assert.equal(snapshot?.targetNodeConfig.id, "script");
    assert.deepEqual(
      snapshot?.workflowDefinition,
      toWorkflowDefinitionGraphDocument(makeDocument()),
    );
  });

  test("run-node freezes Waiting Upstream static input snapshots while dependencies stay generated-parent-only", () => {
    let nodeExecutionIndex = 0;
    let taskRunIndex = 0;
    const document = makeWaitingUpstreamFreezeDocument();

    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "image" },
        createNodeExecutionId: () => `node-execution-${++nodeExecutionIndex}`,
        createTaskRunId: () => `task-run-${++taskRunIndex}`,
        document,
        documentRevision: 77,
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { image: 2, source: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.nodeExecutionsToCreate.map((execution) => ({
        id: execution.id,
        nodeId: execution.nodeId,
      })),
      [
        { id: "node-execution-1", nodeId: "source" },
        { id: "node-execution-2", nodeId: "image" },
      ],
    );
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        id: taskRun.id,
        itemIndex: taskRun.itemIndex,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        {
          id: "task-run-1",
          itemIndex: 0,
          nodeId: "source",
          status: "QUEUED",
        },
        {
          id: "task-run-2",
          itemIndex: 1,
          nodeId: "source",
          status: "QUEUED",
        },
        {
          id: "task-run-3",
          itemIndex: 0,
          nodeId: "image",
          status: "WAITING_UPSTREAM",
        },
        {
          id: "task-run-4",
          itemIndex: 1,
          nodeId: "image",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
    assert.deepEqual(
      plan.taskDependenciesToCreate.map((dependency) => ({
        childTaskRunId: dependency.childTaskRunId,
        parentItemIndex: dependency.parentItemIndex,
        parentNodeId: dependency.parentNodeId,
        sourceHandle: dependency.sourceHandle,
        targetHandle: dependency.targetHandle,
      })),
      [
        {
          childTaskRunId: "task-run-3",
          parentItemIndex: 1,
          parentNodeId: "source",
          sourceHandle: "text",
          targetHandle: "prompt",
        },
        {
          childTaskRunId: "task-run-4",
          parentItemIndex: 0,
          parentNodeId: "source",
          sourceHandle: "text",
          targetHandle: "prompt",
        },
      ],
    );

    const waitingSnapshot = plan.taskRunsToCreate.find(
      (taskRun) => taskRun.id === "task-run-3",
    )?.inputSnapshot;
    assert.equal(waitingSnapshot?.documentRevision, 77);
    assert.equal(
      waitingSnapshot?.idempotencyKey,
      "task_run:task-run-3:attempt:0",
    );
    assert.equal(waitingSnapshot?.targetNodeConfig.id, "image");
    assert.equal(
      waitingSnapshot?.targetNodeConfig.kind === "imageGenerator"
        ? waitingSnapshot.targetNodeConfig.reviewEnabled
        : null,
      true,
    );
    assert.deepEqual(
      waitingSnapshot?.targetNodeConfig.kind === "imageGenerator"
        ? waitingSnapshot.targetNodeConfig.config
        : null,
      { aspectRatio: "16:9" },
    );
    assert.equal(
      waitingSnapshot?.providerInput.kind,
      "image-generation-request",
    );
    assert.equal(
      waitingSnapshot?.providerInput.kind === "image-generation-request"
        ? waitingSnapshot.providerInput.request.prompt
        : null,
      "Paint alpha with frozen lighting",
    );
    assert.equal(
      waitingSnapshot?.providerInput.kind === "image-generation-request"
        ? waitingSnapshot.providerInput.request.referenceImages?.[0]?.id
        : null,
      "asset-reference-frozen",
    );
    assert.deepEqual(waitingSnapshot?.resolvedParentTaskRuns, []);
    assert.deepEqual(
      waitingSnapshot?.workflowDefinition,
      toWorkflowDefinitionGraphDocument(document),
    );
  });

  test("run-node uses injected plan identities consistently across Task Dependencies", () => {
    let nodeExecutionIndex = 0;
    let taskRunIndex = 0;

    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
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
        command: { type: "run-node", nodeId: "image" },
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
        command: { type: "run-node", nodeId: "script" },
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

  test("fails malformed direct Task Run Input Materialization before worker execution", () => {
    const document = makeOutputReorderDependencyDocument();
    const reorder = document.nodes.find((node) => node.id === "reorder");
    const malformedDocument: WorkflowDocument = {
      ...document,
      nodes: document.nodes.map((node) =>
        node === reorder && node.kind === "outputReorder"
          ? { ...node, order: [0] }
          : node,
      ),
    };

    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        document: malformedDocument,
        latestNodeExecutions: [
          latestNodeExecution("source-execution", "source"),
        ],
        latestTaskRuns: [
          latestTaskRun({
            id: "source-task-0",
            itemIndex: 0,
            nodeExecutionId: "source-execution",
            status: "APPROVED",
          }),
          latestTaskRun({
            id: "source-task-1",
            itemIndex: 1,
            nodeExecutionId: "source-execution",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { script: 2, source: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.taskRunsToCreate
        .filter((taskRun) => taskRun.nodeId === "script")
        .map((taskRun) => ({
          failureReason: taskRun.failureReason,
          inputSnapshot: taskRun.inputSnapshot ?? null,
          status: taskRun.status,
        })),
      [
        {
          failureReason: "EXECUTION_FAILED",
          inputSnapshot: null,
          status: "FAILED",
        },
        {
          failureReason: "EXECUTION_FAILED",
          inputSnapshot: null,
          status: "FAILED",
        },
      ],
    );
  });

  test("run-node reuses latest upstream Node Executions and creates only the missing target batch", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
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

  test("run-node creates next upstream attempts for recoverable failed latest slots", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
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

  test("run-node does not duplicate active upstream attempts", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
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

  test("run-node rejects when the target latest Node Execution has active Task Runs", () => {
    const result = planWorkflowRun({
      command: { type: "run-node", nodeId: "script" },
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
        "Cannot run node script because its latest Node Execution has active Task Runs.",
    });
  });

  test("run-node creates a new target batch when the latest target execution is terminal and reuses approved upstream", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
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

  test("run-node creates a new Node Execution with fresh Attempt 0 Task Runs", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
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

  test("run-node materializes fresh snapshots for every planned Item Index from current blueprint settings", () => {
    const topic = makeNode("list", "topic");
    const prompt = makeNode("prompt", "prompt");
    const script = makeNode("llmGenerator", "script");
    const document: WorkflowDocument = {
      version: WORKFLOW_DOCUMENT_VERSION,
      nodes: [
        topic.kind === "list" ? { ...topic, items: ["alpha", "beta"] } : topic,
        prompt.kind === "prompt"
          ? {
              ...prompt,
              prompt: "Current {{topic}} blueprint",
              variables: [{ key: "topic", label: "Topic" }],
            }
          : prompt,
        {
          ...script,
          config: { maxOutputTokens: 64, temperature: 0.2 },
        },
      ],
      edges: makeDocument().edges,
    };

    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        createNodeExecutionId: () => "node-execution-script-current",
        createTaskRunId: (() => {
          let index = 0;
          return () => `task-run-script-current-${index++}`;
        })(),
        document,
        documentRevision: 88,
        latestNodeExecutions: [
          latestNodeExecution("script-execution-old", "script"),
        ],
        latestTaskRuns: [
          latestTaskRun({
            attempt: 5,
            id: "script-old-attempt",
            itemIndex: 0,
            nodeExecutionId: "script-execution-old",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { script: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        attempt: taskRun.attempt,
        id: taskRun.id,
        itemIndex: taskRun.itemIndex,
        nodeExecutionId: taskRun.nodeExecutionId,
        status: taskRun.status,
      })),
      [
        {
          attempt: 0,
          id: "task-run-script-current-0",
          itemIndex: 0,
          nodeExecutionId: "node-execution-script-current",
          status: "QUEUED",
        },
        {
          attempt: 0,
          id: "task-run-script-current-1",
          itemIndex: 1,
          nodeExecutionId: "node-execution-script-current",
          status: "QUEUED",
        },
      ],
    );
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => {
        const snapshot = taskRun.inputSnapshot;
        assert.ok(snapshot);
        assert.equal(snapshot.targetNodeConfig.id, "script");
        assert.deepEqual(
          snapshot.targetNodeConfig.kind === "llmGenerator"
            ? snapshot.targetNodeConfig.config
            : null,
          { maxOutputTokens: 64, temperature: 0.2, thinkingLevel: "LOW" },
        );

        return {
          attempt: snapshot.attempt,
          documentRevision: snapshot.documentRevision,
          idempotencyKey: snapshot.idempotencyKey,
          prompt:
            snapshot.providerInput.kind === "llm-generation-request"
              ? snapshot.providerInput.request.prompt
              : null,
          taskRunId: snapshot.taskRunId,
        };
      }),
      [
        {
          attempt: 0,
          documentRevision: 88,
          idempotencyKey: "task_run:task-run-script-current-0:attempt:0",
          prompt: "Current alpha blueprint",
          taskRunId: "task-run-script-current-0",
        },
        {
          attempt: 0,
          documentRevision: 88,
          idempotencyKey: "task_run:task-run-script-current-1:attempt:0",
          prompt: "Current beta blueprint",
          taskRunId: "task-run-script-current-1",
        },
      ],
    );
  });

  test("run-node rejects when the latest Node Execution has active Task Runs", () => {
    const result = planWorkflowRun({
      command: { type: "run-node", nodeId: "script" },
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
        "Cannot run node script because its latest Node Execution has active Task Runs.",
    });
  });

  test("run-task-slot preserves the Node Execution and creates the next Attempt for the selected Item Index", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: {
          itemIndex: 1,
          nodeExecutionId: "script-execution",
          type: "run-task-slot",
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

  test("run-task-slot creates dependencies to latest approved parent executions before queueing the next Attempt", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: {
          itemIndex: 0,
          nodeExecutionId: "script-execution",
          type: "run-task-slot",
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

  test("run-task-slot materializes selected next Attempt snapshots while historical Attempts stay frozen", () => {
    const document = makeWaitingUpstreamFreezeDocument();
    const plan = unwrap(
      planWorkflowRun({
        command: {
          itemIndex: 1,
          nodeExecutionId: "image-execution",
          type: "run-task-slot",
        },
        createTaskRunId: () => "image-task-regenerated-1",
        document,
        documentRevision: 101,
        latestNodeExecutions: [
          latestNodeExecution("source-execution", "source"),
          latestNodeExecution("image-execution", "image"),
        ],
        latestTaskRuns: [
          latestTaskRun({
            attempt: 0,
            id: "source-task-0",
            itemIndex: 0,
            nodeExecutionId: "source-execution",
            status: "APPROVED",
          }),
          latestTaskRun({
            attempt: 0,
            id: "source-task-1",
            itemIndex: 1,
            nodeExecutionId: "source-execution",
            status: "APPROVED",
          }),
          latestTaskRun({
            attempt: 2,
            id: "image-task-historical-0",
            itemIndex: 0,
            nodeExecutionId: "image-execution",
            status: "APPROVED",
          }),
          latestTaskRun({
            attempt: 3,
            id: "image-task-historical-1",
            itemIndex: 1,
            nodeExecutionId: "image-execution",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { image: 2, source: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        attempt: taskRun.attempt,
        id: taskRun.id,
        itemIndex: taskRun.itemIndex,
        nodeExecutionId: taskRun.nodeExecutionId,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        {
          attempt: 4,
          id: "image-task-regenerated-1",
          itemIndex: 1,
          nodeExecutionId: "image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
      ],
    );
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => {
        const snapshot = taskRun.inputSnapshot;
        assert.ok(snapshot);

        return {
          attempt: snapshot.attempt,
          documentRevision: snapshot.documentRevision,
          idempotencyKey: snapshot.idempotencyKey,
          prompt:
            snapshot.providerInput.kind === "image-generation-request"
              ? snapshot.providerInput.request.prompt
              : null,
          referenceAssetId:
            snapshot.providerInput.kind === "image-generation-request"
              ? snapshot.providerInput.request.referenceImages?.[0]?.id
              : null,
          resolvedParents: snapshot.resolvedParentTaskRuns,
          targetConfig:
            snapshot.targetNodeConfig.kind === "imageGenerator"
              ? snapshot.targetNodeConfig.config
              : null,
        };
      }),
      [
        {
          attempt: 4,
          documentRevision: 101,
          idempotencyKey: "task_run:image-task-regenerated-1:attempt:4",
          prompt: "Paint beta with frozen lighting",
          referenceAssetId: "asset-reference-frozen",
          resolvedParents: [],
          targetConfig: { aspectRatio: "16:9" },
        },
      ],
    );
    assert.deepEqual(
      plan.taskDependenciesToCreate.map((dependency) => ({
        childTaskRunId: dependency.childTaskRunId,
        parentItemIndex: dependency.parentItemIndex,
        parentNodeExecutionId: dependency.parentNodeExecutionId,
        parentNodeId: dependency.parentNodeId,
      })),
      [
        {
          childTaskRunId: "image-task-regenerated-1",
          parentItemIndex: 0,
          parentNodeExecutionId: "source-execution",
          parentNodeId: "source",
        },
      ],
    );
  });

  test("run-task-slot rejects when the selected latest Attempt is active", () => {
    const result = planWorkflowRun({
      command: {
        itemIndex: 0,
        nodeExecutionId: "script-execution",
        type: "run-task-slot",
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
        "Cannot run Item Index 0 for Node Execution script-execution because the latest Attempt is active.",
    });
  });

  test("run-task-slot rejects an invalid selected Item Index", () => {
    const result = planWorkflowRun({
      command: {
        itemIndex: -1,
        nodeExecutionId: "script-execution",
        type: "run-task-slot",
      },
      document: makeDocument(),
      latestNodeExecutions: [latestNodeExecution("script-execution", "script")],
      latestTaskRuns: [],
      ownerId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
      _tag: "WorkflowRunPlannerError",
      message:
        "Cannot run invalid Item Index -1 for Node Execution script-execution.",
    });
  });
});
