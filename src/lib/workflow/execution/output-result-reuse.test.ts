import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import {
  getGeneratorOutputValueType,
  selectReusableWorkflowOutputs,
} from "~/lib/workflow/execution/output-result-reuse";
import type {
  NodeOutputArtifact,
  WorkflowOutputResultArtifact,
} from "~/lib/workflow/execution/types";
import { LLM_ESTIMATED_CREDIT_COST } from "~/lib/workflow/llm-models";
import { estimateWorkflowExecution } from "~/lib/workflow/pricing";

function textOutput(params?: Partial<NodeOutputArtifact>) {
  return {
    attempt: 0,
    documentRevision: null,
    idempotencyKey: "cached-output",
    inputHash: "old-input-hash",
    outputIndex: 0,
    model: null,
    nodeId: "llm",
    ownerUserId: "user",
    projectId: "project",
    promptSnapshot: "old prompt",
    reviewStatus: null,
    executionId: "old-run",
    value: { items: ["chosen output"], type: "text" as const },
    ...params,
  } satisfies NodeOutputArtifact;
}

describe("workflow output result reuse", () => {
  test("selects latest reusable successful materialized outputs by output", () => {
    const candidates = [
      {
        ...textOutput({ executionId: "older-success" }),
        status: "success" as const,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        attempt: 0,
        error: "failed",
        failedAt: "2026-01-02T00:00:00.000Z",
        outputIndex: 0,
        nodeId: "llm",
        ownerUserId: "user",
        projectId: "project",
        executionId: "newer-error",
        status: "error" as const,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        ...textOutput({ outputIndex: 1, value: { items: [""], type: "text" } }),
        status: "success" as const,
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
      {
        ...textOutput({
          outputIndex: 2,
          value: { items: ["image"], type: "text" },
        }),
        status: "success" as const,
        updatedAt: "2026-01-04T00:00:00.000Z",
      },
    ] satisfies (WorkflowOutputResultArtifact & { updatedAt: string })[];

    assert.deepEqual(
      selectReusableWorkflowOutputs({
        candidates,
        expectedOutputs: [
          {
            outputIndex: 0,
            nodeId: "llm",
            role: "requested-target",
            reviewEnabled: false,
            valueType: "text",
          },
          {
            outputIndex: 1,
            nodeId: "llm",
            role: "requested-target",
            reviewEnabled: false,
            valueType: "text",
          },
          {
            outputIndex: 2,
            nodeId: "llm",
            role: "requested-target",
            reviewEnabled: false,
            valueType: "image",
          },
        ],
        reusePolicy: { type: "dependencies-only" },
      }),
      [],
    );
  });

  test("does not reuse direct non-review target outputs", () => {
    const output = {
      ...textOutput({
        documentRevision: 1,
        inputHash: "previous-input",
        model: "previous-model",
        promptSnapshot: "previous prompt",
      }),
      status: "success" as const,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    assert.deepEqual(
      selectReusableWorkflowOutputs({
        candidates: [output],
        expectedOutputs: [
          {
            outputIndex: 0,
            nodeId: "llm",
            role: "requested-target",
            reviewEnabled: false,
            valueType: "text",
          },
        ],
        reusePolicy: { type: "dependencies-only" },
      }),
      [],
    );
  });

  test("reuses non-review dependency outputs", () => {
    const output = {
      ...textOutput({
        documentRevision: 1,
        inputHash: "previous-input",
        model: "previous-model",
        promptSnapshot: "previous prompt",
      }),
      status: "success" as const,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    assert.deepEqual(
      selectReusableWorkflowOutputs({
        candidates: [output],
        expectedOutputs: [
          {
            outputIndex: 0,
            nodeId: "llm",
            role: "dependency",
            reviewEnabled: false,
            valueType: "text",
          },
        ],
        reusePolicy: { type: "dependencies-only" },
      }),
      [output],
    );
  });

  test("reuses direct target outputs only when requested for recovery", () => {
    const output = {
      ...textOutput(),
      status: "success" as const,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const failedRequestedOutput = {
      attempt: 0,
      error: "failed",
      failedAt: "2026-01-02T00:00:00.000Z",
      outputIndex: 1,
      nodeId: "llm",
      ownerUserId: "user",
      projectId: "project",
      executionId: "failed-run",
      status: "error" as const,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };

    assert.deepEqual(
      selectReusableWorkflowOutputs({
        candidates: [output, failedRequestedOutput],
        expectedOutputs: [
          {
            outputIndex: 0,
            nodeId: "llm",
            role: "requested-target",
            reviewEnabled: false,
            valueType: "text",
          },
          {
            outputIndex: 1,
            nodeId: "llm",
            role: "requested-target",
            reviewEnabled: false,
            valueType: "text",
          },
        ],
        reusePolicy: { type: "recover-requested-targets" },
      }),
      [output],
    );
  });

  test("does not recover requested targets without a failed requested output", () => {
    const output = {
      ...textOutput(),
      status: "success" as const,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    assert.deepEqual(
      selectReusableWorkflowOutputs({
        candidates: [output],
        expectedOutputs: [
          {
            outputIndex: 0,
            nodeId: "llm",
            role: "requested-target",
            reviewEnabled: false,
            valueType: "text",
          },
        ],
        reusePolicy: { type: "recover-requested-targets" },
      }),
      [],
    );
  });

  test("reuses approved review-enabled dependency outputs", () => {
    const output = {
      ...textOutput({ reviewStatus: "approved" }),
      status: "success" as const,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    assert.deepEqual(
      selectReusableWorkflowOutputs({
        candidates: [output],
        expectedOutputs: [
          {
            outputIndex: 0,
            nodeId: "llm",
            role: "dependency",
            reviewEnabled: true,
            valueType: "text",
          },
        ],
        reusePolicy: { type: "dependencies-only" },
      }),
      [output],
    );
  });

  test("does not reuse direct review-enabled target outputs", () => {
    const output = {
      ...textOutput({ reviewStatus: "approved" }),
      status: "success" as const,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    assert.deepEqual(
      selectReusableWorkflowOutputs({
        candidates: [output],
        expectedOutputs: [
          {
            outputIndex: 0,
            nodeId: "llm",
            role: "requested-target",
            reviewEnabled: true,
            valueType: "text",
          },
        ],
        reusePolicy: { type: "dependencies-only" },
      }),
      [],
    );
  });

  test("does not reuse unapproved review-enabled dependency outputs", () => {
    const output = {
      ...textOutput({ reviewStatus: "pending" }),
      status: "success" as const,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    assert.deepEqual(
      selectReusableWorkflowOutputs({
        candidates: [output],
        expectedOutputs: [
          {
            outputIndex: 0,
            nodeId: "llm",
            role: "dependency",
            reviewEnabled: true,
            valueType: "text",
          },
        ],
        reusePolicy: { type: "dependencies-only" },
      }),
      [],
    );
  });

  test("derives reusable value type from the current generator node", () => {
    assert.equal(
      getGeneratorOutputValueType(createWorkflowNode("imageGenerator", 0)),
      "image",
    );
    assert.equal(
      getGeneratorOutputValueType(createWorkflowNode("videoGenerator", 0)),
      "video",
    );
    assert.equal(
      getGeneratorOutputValueType(createWorkflowNode("llmGenerator", 0)),
      "text",
    );
    assert.equal(
      getGeneratorOutputValueType(createWorkflowNode("prompt", 0)),
      null,
    );
  });

  test("credit quote excludes completed output keys", () => {
    const list = {
      ...createWorkflowNode("list", 0),
      id: "list",
      items: ["one", "two", "three"],
    };
    const prompt = {
      ...createWorkflowNode("prompt", 1),
      id: "prompt",
      prompt: "{{variable1}}",
      variables: [{ key: "variable1", label: "Variable 1" }],
    };
    const llm = { ...createWorkflowNode("llmGenerator", 2), id: "llm" };
    const document: WorkflowDocument = {
      edges: [
        {
          id: "list-prompt",
          source: "list",
          sourceHandle: "text",
          target: "prompt",
          targetHandle: "variable1",
        },
        {
          id: "prompt-llm",
          source: "prompt",
          sourceHandle: "text",
          target: "llm",
          targetHandle: "prompt",
        },
      ],
      nodes: [list, prompt, llm],
      version: WORKFLOW_DOCUMENT_VERSION,
    };

    assert.equal(
      estimateWorkflowExecution({
        document,
        target: { type: "node", nodeId: "llm" },
      }).totalCost,
      LLM_ESTIMATED_CREDIT_COST * 3,
    );
    assert.equal(
      estimateWorkflowExecution(
        { document, target: { type: "node", nodeId: "llm" } },
        { completedOutputKeys: new Set(["llm:0", "llm:2"]) },
      ).totalCost,
      LLM_ESTIMATED_CREDIT_COST,
    );
  });
});
