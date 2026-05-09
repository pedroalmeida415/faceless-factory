import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  materializeTaskInput,
  materializeWorkflowRunTaskFacts,
} from "~/features/runtime/materialization/task-input-materialization";
import {
  createWorkflowNode,
  toWorkflowDefinitionGraphDocument,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
} from "~/features/workflow/document";

describe("Task Input Materialization", () => {
  test("plans output reorder and broadcast generated-parent addresses through the materialization interface", () => {
    const facts = materializeWorkflowRunTaskFacts({
      document: reorderedGeneratedTextWorkflowDocument(),
      plannedItemCountByNodeId: { source: 1, script: 3 },
      targetNodeIds: ["script"],
    });

    assert.equal(facts.ok, true);
    assert.ok(facts.ok);
    assert.deepEqual(facts.value.itemCountByNodeId, {
      script: 3,
      source: 1,
    });
    assert.deepEqual(
      facts.value.taskFacts
        .filter((fact) => fact.nodeId === "script")
        .map((fact) => ({
          dependencyAddresses: fact.dependencyAddresses,
          branchIndex: fact.branchIndex,
        })),
      [
        {
          dependencyAddresses: [
            {
              parentBranchIndex: 0,
              parentNodeId: "source",
              sourceHandle: "text",
              targetHandle: "prompt",
              targetNodeId: "script",
            },
          ],
          branchIndex: 0,
        },
        {
          dependencyAddresses: [
            {
              parentBranchIndex: 0,
              parentNodeId: "source",
              sourceHandle: "text",
              targetHandle: "prompt",
              targetNodeId: "script",
            },
          ],
          branchIndex: 1,
        },
        {
          dependencyAddresses: [
            {
              parentBranchIndex: 0,
              parentNodeId: "source",
              sourceHandle: "text",
              targetHandle: "prompt",
              targetNodeId: "script",
            },
          ],
          branchIndex: 2,
        },
      ],
    );
  });

  test("materializes a direct runnable Task into an executable immutable input snapshot", () => {
    const result = materializeTaskInput({
      document: directLlmWorkflowDocument(),
      documentRevision: 17,
      branchIndex: 1,
      nodeRunId: "node-execution-script",
      nodeId: "script",
      taskId: "task-run-script-1",
    });

    assert.equal(result.ok, true);
    assert.ok(result.ok);

    assert.deepEqual(
      { ...result.value, workflowDefinition: undefined },
      {
        documentRevision: 17,
        idempotencyKey: "task:task-run-script-1",
        branchIndex: 1,
        kind: "task-input-snapshot",
        nodeRunId: "node-execution-script",
        nodeId: "script",
        providerInput: {
          kind: "llm-generation-request",
          request: {
            idempotencyKey: "task:task-run-script-1",
            maxOutputTokens: 1024,
            mode: null,
            model: "gemini-3-flash-preview",
            prompt: "Write about factories",
            referenceImages: [],
            systemPrompt: "Use a dry narrator.",
            temperature: 0.4,
            thinkingLevel: "LOW",
          },
        },
        resolvedParentTasks: [],
        targetNodeConfig: result.value.targetNodeConfig,
        taskId: "task-run-script-1",
        version: 1,
        workflowDefinition: undefined,
      },
    );
    assert.equal(result.value.targetNodeConfig.id, "script");
    assert.equal(result.value.targetNodeConfig.kind, "llmGenerator");
    assert.deepEqual(result.value.targetNodeConfig.config, {
      maxOutputTokens: 1024,
      temperature: 0.4,
      thinkingLevel: "LOW",
    });
    assert.deepEqual(
      result.value.workflowDefinition,
      toWorkflowDefinitionGraphDocument(directLlmWorkflowDocument()),
    );
  });
});

function reorderedGeneratedTextWorkflowDocument(): WorkflowDocument {
  const source = createWorkflowNode("llmGenerator", 0);
  const reorder = createWorkflowNode("outputReorder", 0);
  const script = createWorkflowNode("llmGenerator", 0);
  if (
    source.kind !== "llmGenerator" ||
    reorder.kind !== "outputReorder" ||
    script.kind !== "llmGenerator"
  ) {
    throw new Error("Unexpected workflow node kind");
  }

  return {
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
    nodes: [
      { ...source, id: "source" },
      {
        ...reorder,
        id: "reorder",
        mode: "manual",
        order: [0],
        valueType: "text",
      },
      { ...script, id: "script" },
    ],
    version: WORKFLOW_DOCUMENT_VERSION,
  };
}

function directLlmWorkflowDocument(): WorkflowDocument {
  const topic = createWorkflowNode("list", 0);
  const prompt = createWorkflowNode("prompt", 0);
  const systemPrompt = createWorkflowNode("prompt", 0);
  const script = createWorkflowNode("llmGenerator", 0);
  if (
    topic.kind !== "list" ||
    prompt.kind !== "prompt" ||
    systemPrompt.kind !== "prompt" ||
    script.kind !== "llmGenerator"
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
        id: "system-to-script",
        source: "system-prompt",
        sourceHandle: "text",
        target: "script",
        targetHandle: "systemPrompt",
      },
    ],
    nodes: [
      { ...topic, id: "topic", items: ["robots", "factories"] },
      {
        ...prompt,
        id: "prompt",
        prompt: "Write about {{topic}}",
        variables: [{ key: "topic", label: "Topic" }],
      },
      {
        ...systemPrompt,
        id: "system-prompt",
        prompt: "Use a dry narrator.",
      },
      {
        ...script,
        config: { maxOutputTokens: 1024, temperature: 0.4 },
        id: "script",
      },
    ],
    version: WORKFLOW_DOCUMENT_VERSION,
  };
}
