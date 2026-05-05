import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  createWorkflowNode,
  toWorkflowDefinitionGraphDocument,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import { materializeDirectTaskRunInput } from "~/lib/workflow-runtime/materialization/task-run-input-materialization";

describe("Task Run Input Materialization", () => {
  test("materializes a direct runnable Task Run into an executable immutable input snapshot", () => {
    const result = materializeDirectTaskRunInput({
      attempt: 2,
      document: directLlmWorkflowDocument(),
      documentRevision: 17,
      itemIndex: 1,
      nodeExecutionId: "node-execution-script",
      nodeId: "script",
      taskRunId: "task-run-script-1",
    });

    assert.equal(result.ok, true);
    assert.ok(result.ok);

    assert.deepEqual(
      { ...result.value, workflowDefinition: undefined },
      {
        attempt: 2,
        documentRevision: 17,
        idempotencyKey: "task_run:task-run-script-1:attempt:2",
        itemIndex: 1,
        kind: "task-run-input-snapshot",
        nodeExecutionId: "node-execution-script",
        nodeId: "script",
        providerInput: {
          kind: "llm-generation-request",
          request: {
            idempotencyKey: "task_run:task-run-script-1:attempt:2",
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
        resolvedParentTaskRuns: [],
        targetNodeConfig: result.value.targetNodeConfig,
        taskRunId: "task-run-script-1",
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
