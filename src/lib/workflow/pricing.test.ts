import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import { estimateWorkflowRuntimeCommand } from "~/lib/workflow/pricing";
import { planWorkflowRun } from "~/lib/workflow-runtime/planning/workflow-run-planner";

describe("Workflow runtime pricing", () => {
  test("estimates run-node Task Run counts from materialized Item Index facts", () => {
    const document = materializedTextFanOutDocument();
    const quote = estimateWorkflowRuntimeCommand({
      command: { nodeId: "summary", type: "run-node" },
      document,
    });
    const plan = unwrapPlan(
      planWorkflowRun({
        command: { nodeId: "summary", type: "run-node" },
        document,
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      iterationsByNodeId(quote.lineItems),
      taskRunCountsByNodeId(plan.taskRunsToCreate),
    );
  });

  test("estimates Run Node Task Run counts including required upstream provider slots", () => {
    const document = materializedTextFanOutDocument();
    const quote = estimateWorkflowRuntimeCommand({
      command: { nodeId: "summary", type: "run-node" },
      document,
    });
    const plan = unwrapPlan(
      planWorkflowRun({
        command: { nodeId: "summary", type: "run-node" },
        document,
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(iterationsByNodeId(quote.lineItems), {
      script: 2,
      summary: 2,
    });
    assert.deepEqual(
      iterationsByNodeId(quote.lineItems),
      taskRunCountsByNodeId(plan.taskRunsToCreate),
    );
  });

  test("estimates Run Task Slot Task Run counts including required upstream provider slots", () => {
    const document = materializedTextFanOutDocument();
    const latestNodeExecutions = [
      { id: "node-execution-summary", nodeId: "summary" },
    ];
    const latestTaskRuns = [
      {
        attempt: 0,
        id: "task-run-summary-0",
        itemIndex: 0,
        nodeExecutionId: "node-execution-summary",
        status: "APPROVED" as const,
      },
      {
        attempt: 0,
        id: "task-run-summary-1",
        itemIndex: 1,
        nodeExecutionId: "node-execution-summary",
        status: "APPROVED" as const,
      },
    ];
    const quote = estimateWorkflowRuntimeCommand({
      command: {
        itemIndex: 1,
        nodeExecutionId: "node-execution-summary",
        type: "run-task-slot",
      },
      document,
      latestNodeExecutions,
    });
    const plan = unwrapPlan(
      planWorkflowRun({
        command: {
          itemIndex: 1,
          nodeExecutionId: "node-execution-summary",
          type: "run-task-slot",
        },
        document,
        latestNodeExecutions,
        latestTaskRuns,
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(iterationsByNodeId(quote.lineItems), {
      script: 1,
      summary: 1,
    });
    assert.deepEqual(
      iterationsByNodeId(quote.lineItems),
      taskRunCountsByNodeId(plan.taskRunsToCreate),
    );
  });

  test("estimates multimodal parent Task Run counts from materialized provider facts", () => {
    const document = multimodalParentWorkflowDocument();
    const quote = estimateWorkflowRuntimeCommand({
      command: { nodeId: "video", type: "run-node" },
      document,
    });
    const plan = unwrapPlan(
      planWorkflowRun({
        command: { nodeId: "video", type: "run-node" },
        document,
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-1",
        workflowId: "workflow-1",
      }),
    );

    assert.deepEqual(
      iterationsByNodeId(quote.lineItems),
      taskRunCountsByNodeId(plan.taskRunsToCreate),
    );
  });
});

function unwrapPlan<T>(result: { ok: true; value: T } | { ok: false }) {
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  return result.value;
}

function iterationsByNodeId(
  lineItems: readonly {
    readonly nodeId: string;
    readonly iterations: number;
  }[],
) {
  return Object.fromEntries(
    lineItems.map((lineItem) => [lineItem.nodeId, lineItem.iterations]),
  );
}

function taskRunCountsByNodeId(
  taskRuns: readonly { readonly nodeId: string }[],
) {
  const counts: Record<string, number> = {};
  for (const taskRun of taskRuns) {
    counts[taskRun.nodeId] = (counts[taskRun.nodeId] ?? 0) + 1;
  }
  return counts;
}

function materializedTextFanOutDocument(): WorkflowDocument {
  const topic = createWorkflowNode("list", 0);
  const prompt = createWorkflowNode("prompt", 0);
  const script = createWorkflowNode("llmGenerator", 0);
  const reorder = createWorkflowNode("outputReorder", 0);
  const summary = createWorkflowNode("llmGenerator", 0);
  if (
    topic.kind !== "list" ||
    prompt.kind !== "prompt" ||
    script.kind !== "llmGenerator" ||
    reorder.kind !== "outputReorder" ||
    summary.kind !== "llmGenerator"
  ) {
    throw new Error("Unexpected workflow node kind");
  }

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
      {
        id: "script-to-reorder",
        source: "script",
        sourceHandle: "text",
        target: "reorder",
        targetHandle: "input",
      },
      {
        id: "reorder-to-summary",
        source: "reorder",
        sourceHandle: "output",
        target: "summary",
        targetHandle: "prompt",
      },
    ],
    nodes: [
      { ...topic, id: "topic", items: ["alpha", "beta"] },
      {
        ...prompt,
        id: "prompt",
        prompt: "Write {{topic}}",
        variables: [{ key: "topic", label: "Topic" }],
      },
      { ...script, id: "script" },
      {
        ...reorder,
        id: "reorder",
        mode: "manual",
        order: [1, 0],
        valueType: "text",
      },
      { ...summary, id: "summary" },
    ],
    version: WORKFLOW_DOCUMENT_VERSION,
  };
}

function multimodalParentWorkflowDocument(): WorkflowDocument {
  const topic = createWorkflowNode("list", 0);
  const prompt = createWorkflowNode("prompt", 0);
  const image = createWorkflowNode("imageGenerator", 0);
  const script = createWorkflowNode("llmGenerator", 0);
  const video = createWorkflowNode("videoGenerator", 0);
  if (
    topic.kind !== "list" ||
    prompt.kind !== "prompt" ||
    image.kind !== "imageGenerator" ||
    script.kind !== "llmGenerator" ||
    video.kind !== "videoGenerator"
  ) {
    throw new Error("Unexpected workflow node kind");
  }

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
        id: "prompt-to-image",
        source: "prompt",
        sourceHandle: "text",
        target: "image",
        targetHandle: "prompt",
      },
      {
        id: "prompt-to-script",
        source: "prompt",
        sourceHandle: "text",
        target: "script",
        targetHandle: "prompt",
      },
      {
        id: "script-to-video",
        source: "script",
        sourceHandle: "text",
        target: "video",
        targetHandle: "prompt",
      },
      {
        id: "image-to-video",
        source: "image",
        sourceHandle: "images",
        target: "video",
        targetHandle: "image-input-0",
      },
    ],
    nodes: [
      { ...topic, id: "topic", items: ["one", "two"] },
      {
        ...prompt,
        id: "prompt",
        prompt: "Make {{topic}}",
        variables: [{ key: "topic", label: "Topic" }],
      },
      { ...image, id: "image" },
      { ...script, id: "script" },
      { ...video, id: "video" },
    ],
    version: WORKFLOW_DOCUMENT_VERSION,
  };
}
