import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { TaskStatus } from "~/features/runtime/domain/task-state";
import { planWorkflowRun } from "~/features/runtime/planning/workflow-run-planner";
import {
  createWorkflowNode,
  toWorkflowDefinitionGraphDocument,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
  type WorkflowDocumentNode,
} from "~/features/workflow/document";

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

function latestNodeRun(id: string, nodeId: string) {
  return { id, nodeId };
}

function latestTask(input: {
  creditCost?: number;
  id: string;
  nodeRunId: string;
  nodeId?: string;
  branchIndex?: number;
  status: TaskStatus;
}) {
  return {
    creditCost: input.creditCost ?? 0,
    id: input.id,
    branchIndex: input.branchIndex ?? 0,
    nodeRunId: input.nodeRunId,
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
        latestNodeRuns: [],
        latestTasks: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.nodeRunsToCreate.map((execution) => execution.nodeId),
      ["script"],
    );
    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        branchIndex: task.branchIndex,
        nodeId: task.nodeId,
        status: task.status,
      })),
      [
        {
          branchIndex: 0,
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
        createNodeRunId: (() => {
          let index = 0;
          return () => `node-execution-${++index}`;
        })(),
        createTaskId: (() => {
          let index = 0;
          return () => `task-run-${++index}`;
        })(),
        document: makeReviewEnabledUpstreamImageDocument(),
        latestNodeRuns: [],
        latestTasks: [],
        ownerId: "owner-1",
        plannedItemCountByNodeId: {
          "downstream-image": 3,
          "upstream-image": 3,
        },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.nodeRunsToCreate.map((execution) => ({
        id: execution.id,
        nodeId: execution.nodeId,
      })),
      [
        { id: "node-execution-1", nodeId: "upstream-image" },
        { id: "node-execution-2", nodeId: "downstream-image" },
      ],
    );
    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        branchIndex: task.branchIndex,
        nodeId: task.nodeId,
        status: task.status,
      })),
      [
        { branchIndex: 0, nodeId: "upstream-image", status: "QUEUED" },
        { branchIndex: 1, nodeId: "upstream-image", status: "QUEUED" },
        { branchIndex: 2, nodeId: "upstream-image", status: "QUEUED" },
        {
          branchIndex: 0,
          nodeId: "downstream-image",
          status: "WAITING_UPSTREAM",
        },
        {
          branchIndex: 1,
          nodeId: "downstream-image",
          status: "WAITING_UPSTREAM",
        },
        {
          branchIndex: 2,
          nodeId: "downstream-image",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
    assert.deepEqual(
      plan.taskDependenciesToCreate.map((dependency) => ({
        childTaskId: dependency.childTaskId,
        parentBranchIndex: dependency.parentBranchIndex,
        parentNodeRunId: dependency.parentNodeRunId,
        parentNodeId: dependency.parentNodeId,
      })),
      [
        {
          childTaskId: "task-run-4",
          parentBranchIndex: 0,
          parentNodeRunId: "node-execution-1",
          parentNodeId: "upstream-image",
        },
        {
          childTaskId: "task-run-5",
          parentBranchIndex: 1,
          parentNodeRunId: "node-execution-1",
          parentNodeId: "upstream-image",
        },
        {
          childTaskId: "task-run-6",
          parentBranchIndex: 2,
          parentNodeRunId: "node-execution-1",
          parentNodeId: "upstream-image",
        },
      ],
    );
  });

  test("Run Cost Preview is derived from the same planned Tasks as creation", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "downstream-image" },
        createNodeRunId: (() => {
          let index = 0;
          return () => `node-execution-${++index}`;
        })(),
        createTaskId: (() => {
          let index = 0;
          return () => `task-run-${++index}`;
        })(),
        document: makeReviewEnabledUpstreamImageDocument(),
        latestNodeRuns: [],
        latestTasks: [],
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
        branchIndex: item.branchIndex,
        nodeId: item.nodeId,
        role: item.role,
        source: item.source,
        status: item.status,
        taskId: item.taskId,
      })),
      plan.tasksToCreate.map((task) => ({
        creditCost: task.creditCost,
        debitTiming:
          task.status === "QUEUED" ? "queued-immediately" : "waiting-upstream",
        branchIndex: task.branchIndex,
        nodeId: task.nodeId,
        role: task.nodeId === "downstream-image" ? "target" : "upstream",
        source: "planned",
        status: task.status,
        taskId: task.id,
      })),
    );
    assert.deepEqual(
      plan.runCostPreview.queuedImmediate.items.map((item) => item.taskId),
      ["task-run-1", "task-run-2"],
    );
    assert.deepEqual(
      plan.runCostPreview.waitingUpstream.items.map((item) => item.taskId),
      ["task-run-3", "task-run-4"],
    );
    assert.equal(
      plan.runCostPreview.newCostTotal,
      plan.tasksToCreate.reduce((total, task) => total + task.creditCost, 0),
    );
    assert.equal(
      plan.runCostPreview.immediateDebitTotal,
      plan.tasksToCreate
        .filter((task) => task.status === "QUEUED")
        .reduce((total, task) => total + task.creditCost, 0),
    );
  });

  test("Run Cost Preview itemizes active upstream Tasks but excludes them from new-cost totals", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "downstream-image" },
        createNodeRunId: () => "downstream-execution-new",
        createTaskId: () => "downstream-task-new",
        document: makeReviewEnabledUpstreamImageDocument(),
        latestNodeRuns: [latestNodeRun("upstream-execution", "upstream-image")],
        latestTasks: [
          latestTask({
            creditCost: 7,
            id: "upstream-task-active",
            nodeRunId: "upstream-execution",
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
        taskId: item.taskId,
      })),
      [
        {
          creditCost: 7,
          debitTiming: "excluded-existing",
          nodeId: "upstream-image",
          role: "upstream",
          source: "stored",
          status: "PENDING_REVIEW",
          taskId: "upstream-task-active",
        },
        {
          creditCost: plan.tasksToCreate[0]?.creditCost,
          debitTiming: "waiting-upstream",
          nodeId: "downstream-image",
          role: "target",
          source: "planned",
          status: "WAITING_UPSTREAM",
          taskId: "downstream-task-new",
        },
      ],
    );
    assert.equal(plan.runCostPreview.excludedExisting.totalCreditCost, 7);
    assert.equal(
      plan.runCostPreview.newCostTotal,
      plan.tasksToCreate[0]?.creditCost,
    );
    assert.equal(plan.runCostPreview.immediateDebitTotal, 0);
  });

  test("assigns immutable credit costs from the Pricing Catalog onto planned Tasks", () => {
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
        latestNodeRuns: [],
        latestTasks: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        creditCost: task.creditCost,
        nodeId: task.nodeId,
        status: task.status,
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

  test("carries the target node configuration snapshot onto planned Tasks", () => {
    const document = makeDocument();
    const definition = toWorkflowDefinitionGraphDocument(document);
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        document,
        latestNodeRuns: [],
        latestTasks: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        nodeId: task.nodeId,
        targetNodeConfig: task.targetNodeConfig,
      })),
      [{ nodeId: "script", targetNodeConfig: definition.nodes[2] }],
    );
  });

  test("materializes direct queued Task input snapshots before persistence", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        createNodeRunId: () => "node-execution-script",
        createTaskId: () => "task-run-script",
        document: makeDocument(),
        documentRevision: 42,
        latestNodeRuns: [],
        latestTasks: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    const snapshot = plan.tasksToCreate[0]?.inputSnapshot;
    assert.equal(snapshot?.taskId, "task-run-script");
    assert.equal(snapshot?.nodeRunId, "node-execution-script");
    assert.equal(snapshot?.branchIndex, 0);
    assert.equal(snapshot?.documentRevision, 42);
    assert.equal(snapshot?.idempotencyKey, "task:task-run-script");
    assert.equal(snapshot?.providerInput.kind, "llm-generation-request");
    assert.equal(
      snapshot?.providerInput.kind === "llm-generation-request"
        ? snapshot.providerInput.request.prompt
        : null,
      "",
    );
    assert.deepEqual(snapshot?.resolvedParentTasks, []);
    assert.equal(snapshot?.targetNodeConfig.id, "script");
    assert.deepEqual(
      snapshot?.workflowDefinition,
      toWorkflowDefinitionGraphDocument(makeDocument()),
    );
  });

  test("run-node freezes Waiting Upstream static input snapshots while dependencies stay generated-parent-only", () => {
    let nodeRunIndex = 0;
    let taskIndex = 0;
    const document = makeWaitingUpstreamFreezeDocument();

    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "image" },
        createNodeRunId: () => `node-execution-${++nodeRunIndex}`,
        createTaskId: () => `task-run-${++taskIndex}`,
        document,
        documentRevision: 77,
        latestNodeRuns: [],
        latestTasks: [],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { image: 2, source: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.nodeRunsToCreate.map((execution) => ({
        id: execution.id,
        nodeId: execution.nodeId,
      })),
      [
        { id: "node-execution-1", nodeId: "source" },
        { id: "node-execution-2", nodeId: "image" },
      ],
    );
    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        id: task.id,
        branchIndex: task.branchIndex,
        nodeId: task.nodeId,
        status: task.status,
      })),
      [
        {
          id: "task-run-1",
          branchIndex: 0,
          nodeId: "source",
          status: "QUEUED",
        },
        {
          id: "task-run-2",
          branchIndex: 1,
          nodeId: "source",
          status: "QUEUED",
        },
        {
          id: "task-run-3",
          branchIndex: 0,
          nodeId: "image",
          status: "WAITING_UPSTREAM",
        },
        {
          id: "task-run-4",
          branchIndex: 1,
          nodeId: "image",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
    assert.deepEqual(
      plan.taskDependenciesToCreate.map((dependency) => ({
        childTaskId: dependency.childTaskId,
        parentBranchIndex: dependency.parentBranchIndex,
        parentNodeId: dependency.parentNodeId,
        sourceHandle: dependency.sourceHandle,
        targetHandle: dependency.targetHandle,
      })),
      [
        {
          childTaskId: "task-run-3",
          parentBranchIndex: 1,
          parentNodeId: "source",
          sourceHandle: "text",
          targetHandle: "prompt",
        },
        {
          childTaskId: "task-run-4",
          parentBranchIndex: 0,
          parentNodeId: "source",
          sourceHandle: "text",
          targetHandle: "prompt",
        },
      ],
    );

    const waitingSnapshot = plan.tasksToCreate.find(
      (task) => task.id === "task-run-3",
    )?.inputSnapshot;
    assert.equal(waitingSnapshot?.documentRevision, 77);
    assert.equal(waitingSnapshot?.idempotencyKey, "task:task-run-3");
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
    assert.deepEqual(waitingSnapshot?.resolvedParentTasks, []);
    assert.deepEqual(
      waitingSnapshot?.workflowDefinition,
      toWorkflowDefinitionGraphDocument(document),
    );
  });

  test("run-node uses injected plan identities consistently across Task Dependencies", () => {
    let nodeRunIndex = 0;
    let taskIndex = 0;

    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        createNodeRunId: () => `node-execution-${++nodeRunIndex}`,
        createTaskId: () => `task-run-${++taskIndex}`,
        document: makeDocument(),
        latestNodeRuns: [],
        latestTasks: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.nodeRunsToCreate.map((execution) => execution.id),
      ["node-execution-1"],
    );
    assert.deepEqual(
      plan.tasksToCreate.map((task) => task.id),
      ["task-run-1"],
    );
    assert.deepEqual(plan.taskDependenciesToCreate, []);
  });

  test("does not create Task Dependencies for static prompt and asset inputs", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "image" },
        document: makeGeneratorInputDocument(),
        latestNodeRuns: [],
        latestTasks: [],
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

  test("maps output-reorder branch indexes onto provider-backed Task Dependencies", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        document: makeOutputReorderDependencyDocument(),
        latestNodeRuns: [],
        latestTasks: [],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { script: 2, source: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.taskDependenciesToCreate.map((dependency) => ({
        childNodeId: dependency.childNodeId,
        childTaskId: dependency.childTaskId,
        parentBranchIndex: dependency.parentBranchIndex,
        parentNodeId: dependency.parentNodeId,
        sourceHandle: dependency.sourceHandle,
        targetHandle: dependency.targetHandle,
      })),
      [
        {
          childNodeId: "script",
          childTaskId: "planned-task-run-3",
          parentBranchIndex: 1,
          parentNodeId: "source",
          sourceHandle: "text",
          targetHandle: "prompt",
        },
        {
          childNodeId: "script",
          childTaskId: "planned-task-run-4",
          parentBranchIndex: 0,
          parentNodeId: "source",
          sourceHandle: "text",
          targetHandle: "prompt",
        },
      ],
    );
  });

  test("fails malformed direct Task Input Materialization before worker execution", () => {
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
        latestNodeRuns: [latestNodeRun("source-execution", "source")],
        latestTasks: [
          latestTask({
            id: "source-task-0",
            branchIndex: 0,
            nodeRunId: "source-execution",
            status: "APPROVED",
          }),
          latestTask({
            id: "source-task-1",
            branchIndex: 1,
            nodeRunId: "source-execution",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { script: 2, source: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.tasksToCreate
        .filter((task) => task.nodeId === "script")
        .map((task) => ({
          failureReason: task.failureReason,
          inputSnapshot: task.inputSnapshot ?? null,
          status: task.status,
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

  test("run-node reuses latest upstream Node Runs and creates only the missing target batch", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        document: makeDocument(),
        latestNodeRuns: [
          latestNodeRun("topic-execution", "topic"),
          latestNodeRun("prompt-execution", "prompt"),
        ],
        latestTasks: [
          latestTask({
            id: "topic-task",
            nodeRunId: "topic-execution",
            status: "APPROVED",
          }),
          latestTask({
            id: "prompt-task",
            nodeRunId: "prompt-execution",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(plan.nodeRunsToReuse, []);
    assert.deepEqual(plan.nodeRunsToCreate, [
      {
        id: "planned-node-execution-1",
        nodeId: "script",
        ownerId: "owner-1",
        workflowId: "workflow-1",
      },
    ]);
    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        nodeRunId: task.nodeRunId,
        nodeId: task.nodeId,
        status: task.status,
      })),
      [
        {
          nodeRunId: "planned-node-execution-1",
          nodeId: "script",
          status: "QUEUED",
        },
      ],
    );
  });

  test("run-node creates replacement upstream Tasks for recoverable failed latest Branches", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        document: makeDocument(),
        latestNodeRuns: [
          latestNodeRun("topic-execution", "topic"),
          latestNodeRun("prompt-execution", "prompt"),
        ],
        latestTasks: [
          latestTask({
            id: "topic-task",
            nodeRunId: "topic-execution",
            status: "FAILED",
          }),
          latestTask({
            id: "prompt-task",
            nodeRunId: "prompt-execution",
            status: "UPSTREAM_FAILED",
          }),
        ],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        nodeRunId: task.nodeRunId,
        nodeId: task.nodeId,
        status: task.status,
      })),
      [
        {
          nodeRunId: "planned-node-execution-1",
          nodeId: "script",
          status: "QUEUED",
        },
      ],
    );
  });

  test("run-node does not duplicate active upstream Tasks", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        document: makeDocument(),
        latestNodeRuns: [
          latestNodeRun("topic-execution", "topic"),
          latestNodeRun("prompt-execution", "prompt"),
        ],
        latestTasks: [
          latestTask({
            id: "topic-task",
            nodeRunId: "topic-execution",
            status: "RUNNING",
          }),
          latestTask({
            id: "prompt-task",
            nodeRunId: "prompt-execution",
            status: "WAITING_UPSTREAM",
          }),
        ],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.tasksToCreate.map((task) => task.nodeId),
      ["script"],
    );
    assert.equal(plan.tasksToCreate[0]?.status, "QUEUED");
  });

  test("run-node rejects when the target latest Node Run has active Tasks", () => {
    const result = planWorkflowRun({
      command: { type: "run-node", nodeId: "script" },
      document: makeDocument(),
      latestNodeRuns: [latestNodeRun("script-execution", "script")],
      latestTasks: [
        latestTask({
          id: "script-task",
          nodeRunId: "script-execution",
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
        "Cannot run node script because its latest Node Run has active Tasks.",
    });
  });

  test("run-node creates a new target batch when the latest target execution is terminal and reuses approved upstream", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        document: makeDocument(),
        latestNodeRuns: [
          latestNodeRun("topic-execution", "topic"),
          latestNodeRun("prompt-execution", "prompt"),
          latestNodeRun("script-execution", "script"),
        ],
        latestTasks: [
          latestTask({
            id: "topic-task",
            nodeRunId: "topic-execution",
            status: "APPROVED",
          }),
          latestTask({
            id: "prompt-task",
            nodeRunId: "prompt-execution",
            status: "APPROVED",
          }),
          latestTask({
            id: "script-task",
            nodeRunId: "script-execution",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(plan.nodeRunsToReuse, []);
    assert.deepEqual(plan.nodeRunsToCreate, [
      {
        id: "planned-node-execution-1",
        nodeId: "script",
        ownerId: "owner-1",
        workflowId: "workflow-1",
      },
    ]);
    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        nodeRunId: task.nodeRunId,
        nodeId: task.nodeId,
        status: task.status,
      })),
      [
        {
          nodeRunId: "planned-node-execution-1",
          nodeId: "script",
          status: "QUEUED",
        },
      ],
    );
  });

  test("run-node creates a new Node Run with fresh Branch Tasks", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        document: makeDocument(),
        latestNodeRuns: [latestNodeRun("script-execution", "script")],
        latestTasks: [
          latestTask({
            id: "script-task",
            branchIndex: 0,
            nodeRunId: "script-execution",
            status: "FAILED",
          }),
        ],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { script: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(plan.nodeRunsToCreate, [
      {
        id: "planned-node-execution-1",
        nodeId: "script",
        ownerId: "owner-1",
        workflowId: "workflow-1",
      },
    ]);
    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        branchIndex: task.branchIndex,
        status: task.status,
      })),
      [
        { branchIndex: 0, status: "QUEUED" },
        { branchIndex: 1, status: "QUEUED" },
      ],
    );
  });

  test("run-node materializes fresh snapshots for every planned Branch Index from current blueprint settings", () => {
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
        createNodeRunId: () => "node-execution-script-current",
        createTaskId: (() => {
          let index = 0;
          return () => `task-run-script-current-${index++}`;
        })(),
        document,
        documentRevision: 88,
        latestNodeRuns: [latestNodeRun("script-execution-old", "script")],
        latestTasks: [
          latestTask({
            id: "script-old-task",
            branchIndex: 0,
            nodeRunId: "script-execution-old",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { script: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        id: task.id,
        branchIndex: task.branchIndex,
        nodeRunId: task.nodeRunId,
        status: task.status,
      })),
      [
        {
          id: "task-run-script-current-0",
          branchIndex: 0,
          nodeRunId: "node-execution-script-current",
          status: "QUEUED",
        },
        {
          id: "task-run-script-current-1",
          branchIndex: 1,
          nodeRunId: "node-execution-script-current",
          status: "QUEUED",
        },
      ],
    );
    assert.deepEqual(
      plan.tasksToCreate.map((task) => {
        const snapshot = task.inputSnapshot;
        assert.ok(snapshot);
        assert.equal(snapshot.targetNodeConfig.id, "script");
        assert.deepEqual(
          snapshot.targetNodeConfig.kind === "llmGenerator"
            ? snapshot.targetNodeConfig.config
            : null,
          { maxOutputTokens: 64, temperature: 0.2, thinkingLevel: "LOW" },
        );

        return {
          documentRevision: snapshot.documentRevision,
          idempotencyKey: snapshot.idempotencyKey,
          prompt:
            snapshot.providerInput.kind === "llm-generation-request"
              ? snapshot.providerInput.request.prompt
              : null,
          taskId: snapshot.taskId,
        };
      }),
      [
        {
          documentRevision: 88,
          idempotencyKey: "task:task-run-script-current-0",
          prompt: "Current alpha blueprint",
          taskId: "task-run-script-current-0",
        },
        {
          documentRevision: 88,
          idempotencyKey: "task:task-run-script-current-1",
          prompt: "Current beta blueprint",
          taskId: "task-run-script-current-1",
        },
      ],
    );
  });

  test("run-node rejects when the latest Node Run has active Tasks", () => {
    const result = planWorkflowRun({
      command: { type: "run-node", nodeId: "script" },
      document: makeDocument(),
      latestNodeRuns: [latestNodeRun("script-execution", "script")],
      latestTasks: [
        latestTask({
          id: "script-task",
          nodeRunId: "script-execution",
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
        "Cannot run node script because its latest Node Run has active Tasks.",
    });
  });

  test("run-task preserves the Node Run and creates a replacement Task for the selected Branch Index", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: {
          branchIndex: 1,
          nodeRunId: "script-execution",
          type: "run-task",
        },
        document: makeDocument(),
        latestNodeRuns: [latestNodeRun("script-execution", "script")],
        latestTasks: [
          latestTask({
            id: "script-task-0",
            branchIndex: 0,
            nodeRunId: "script-execution",
            status: "APPROVED",
          }),
          latestTask({
            id: "script-task-1",
            branchIndex: 1,
            nodeRunId: "script-execution",
            status: "CANCELLED",
          }),
        ],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(plan.nodeRunsToCreate, []);
    assert.deepEqual(plan.nodeRunsToReuse, [
      { id: "script-execution", nodeId: "script" },
    ]);
    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        branchIndex: task.branchIndex,
        nodeRunId: task.nodeRunId,
        nodeId: task.nodeId,
      })),
      [
        {
          branchIndex: 1,
          nodeRunId: "script-execution",
          nodeId: "script",
        },
      ],
    );
  });

  test("run-task creates dependencies to latest approved parent executions before queueing the replacement Task", () => {
    const plan = unwrap(
      planWorkflowRun({
        command: {
          branchIndex: 0,
          nodeRunId: "script-execution",
          type: "run-task",
        },
        document: makeOutputReorderDependencyDocument(),
        latestNodeRuns: [
          latestNodeRun("source-execution", "source"),
          latestNodeRun("script-execution", "script"),
        ],
        latestTasks: [
          latestTask({
            id: "source-task-0",
            branchIndex: 1,
            nodeRunId: "source-execution",
            status: "APPROVED",
          }),
          latestTask({
            id: "script-task-0",
            nodeRunId: "script-execution",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { script: 2, source: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(plan.nodeRunsToReuse, [
      { id: "script-execution", nodeId: "script" },
      { id: "source-execution", nodeId: "source" },
    ]);
    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        id: task.id,
        nodeRunId: task.nodeRunId,
        nodeId: task.nodeId,
        status: task.status,
      })),
      [
        {
          id: "planned-task-run-1",
          nodeRunId: "script-execution",
          nodeId: "script",
          status: "QUEUED",
        },
      ],
    );
    assert.deepEqual(plan.taskDependenciesToCreate, [
      {
        childNodeRunId: "script-execution",
        childNodeId: "script",
        childTaskId: "planned-task-run-1",
        parentBranchIndex: 1,
        parentNodeRunId: "source-execution",
        parentNodeId: "source",
        sourceHandle: "text",
        targetHandle: "prompt",
        targetNodeId: "script",
      },
    ]);
  });

  test("run-task materializes selected replacement Task snapshots while historical Tasks stay frozen", () => {
    const document = makeWaitingUpstreamFreezeDocument();
    const plan = unwrap(
      planWorkflowRun({
        command: {
          branchIndex: 1,
          nodeRunId: "image-execution",
          type: "run-task",
        },
        createTaskId: () => "image-task-regenerated-1",
        document,
        documentRevision: 101,
        latestNodeRuns: [
          latestNodeRun("source-execution", "source"),
          latestNodeRun("image-execution", "image"),
        ],
        latestTasks: [
          latestTask({
            id: "source-task-0",
            branchIndex: 0,
            nodeRunId: "source-execution",
            status: "APPROVED",
          }),
          latestTask({
            id: "source-task-1",
            branchIndex: 1,
            nodeRunId: "source-execution",
            status: "APPROVED",
          }),
          latestTask({
            id: "image-task-historical-0",
            branchIndex: 0,
            nodeRunId: "image-execution",
            status: "APPROVED",
          }),
          latestTask({
            id: "image-task-historical-1",
            branchIndex: 1,
            nodeRunId: "image-execution",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-1",
        plannedItemCountByNodeId: { image: 2, source: 2 },
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        id: task.id,
        branchIndex: task.branchIndex,
        nodeRunId: task.nodeRunId,
        nodeId: task.nodeId,
        status: task.status,
      })),
      [
        {
          id: "image-task-regenerated-1",
          branchIndex: 1,
          nodeRunId: "image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
      ],
    );
    assert.deepEqual(
      plan.tasksToCreate.map((task) => {
        const snapshot = task.inputSnapshot;
        assert.ok(snapshot);

        return {
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
          resolvedParents: snapshot.resolvedParentTasks,
          targetConfig:
            snapshot.targetNodeConfig.kind === "imageGenerator"
              ? snapshot.targetNodeConfig.config
              : null,
        };
      }),
      [
        {
          documentRevision: 101,
          idempotencyKey: "task:image-task-regenerated-1",
          prompt: "Paint beta with frozen lighting",
          referenceAssetId: "asset-reference-frozen",
          resolvedParents: [],
          targetConfig: { aspectRatio: "16:9" },
        },
      ],
    );
    assert.deepEqual(
      plan.taskDependenciesToCreate.map((dependency) => ({
        childTaskId: dependency.childTaskId,
        parentBranchIndex: dependency.parentBranchIndex,
        parentNodeRunId: dependency.parentNodeRunId,
        parentNodeId: dependency.parentNodeId,
      })),
      [
        {
          childTaskId: "image-task-regenerated-1",
          parentBranchIndex: 0,
          parentNodeRunId: "source-execution",
          parentNodeId: "source",
        },
      ],
    );
  });

  test("run-task rejects when the selected latest Task is active", () => {
    const result = planWorkflowRun({
      command: {
        branchIndex: 0,
        nodeRunId: "script-execution",
        type: "run-task",
      },
      document: makeDocument(),
      latestNodeRuns: [latestNodeRun("script-execution", "script")],
      latestTasks: [
        latestTask({
          id: "script-task",
          branchIndex: 0,
          nodeRunId: "script-execution",
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
        "Cannot run Branch Index 0 for Node Run script-execution because the latest Task is active.",
    });
  });

  test("run-task rejects an invalid selected Branch Index", () => {
    const result = planWorkflowRun({
      command: {
        branchIndex: -1,
        nodeRunId: "script-execution",
        type: "run-task",
      },
      document: makeDocument(),
      latestNodeRuns: [latestNodeRun("script-execution", "script")],
      latestTasks: [],
      ownerId: "owner-1",
      workflowId: "workflow-1",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
      _tag: "WorkflowRunPlannerError",
      message:
        "Cannot run invalid Branch Index -1 for Node Run script-execution.",
    });
  });
});
