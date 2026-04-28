import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import {
  getGeneratorLaneValueType,
  selectReusableWorkflowLaneOutputs,
} from "~/lib/workflow/execution/lane-result-reuse";
import type {
  NodeLaneOutputArtifact,
  WorkflowLaneResultArtifact,
} from "~/lib/workflow/execution/types";
import { LLM_ESTIMATED_CREDIT_COST } from "~/lib/workflow/llm-models";
import { estimateWorkflowExecution } from "~/lib/workflow/pricing";

function textOutput(params?: Partial<NodeLaneOutputArtifact>) {
  return {
    attempt: 0,
    documentRevision: null,
    idempotencyKey: "cached-output",
    inputHash: "old-input-hash",
    laneIndex: 0,
    model: null,
    nodeId: "llm",
    ownerUserId: "user",
    projectId: "project",
    promptSnapshot: "old prompt",
    runId: "old-run",
    value: { lanes: ["chosen output"], type: "text" as const },
    ...params,
  } satisfies NodeLaneOutputArtifact;
}

describe("workflow lane result reuse", () => {
  test("selects latest reusable successful materialized outputs by lane", () => {
    const candidates = [
      {
        ...textOutput({ runId: "older-success" }),
        status: "success" as const,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        attempt: 0,
        error: "failed",
        failedAt: "2026-01-02T00:00:00.000Z",
        laneIndex: 0,
        nodeId: "llm",
        ownerUserId: "user",
        projectId: "project",
        runId: "newer-error",
        status: "error" as const,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        ...textOutput({ laneIndex: 1, value: { lanes: [""], type: "text" } }),
        status: "success" as const,
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
      {
        ...textOutput({
          laneIndex: 2,
          value: { lanes: ["image"], type: "text" },
        }),
        status: "success" as const,
        updatedAt: "2026-01-04T00:00:00.000Z",
      },
    ] satisfies (WorkflowLaneResultArtifact & { updatedAt: string })[];

    assert.deepEqual(
      selectReusableWorkflowLaneOutputs({
        candidates,
        expectedLanes: [
          { laneIndex: 0, nodeId: "llm", valueType: "text" },
          { laneIndex: 1, nodeId: "llm", valueType: "text" },
          { laneIndex: 2, nodeId: "llm", valueType: "image" },
        ],
      }),
      [],
    );
  });

  test("ignores input and config snapshots when the latest lane output is reusable", () => {
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
      selectReusableWorkflowLaneOutputs({
        candidates: [output],
        expectedLanes: [{ laneIndex: 0, nodeId: "llm", valueType: "text" }],
      }),
      [output],
    );
  });

  test("derives reusable value type from the current generator node", () => {
    assert.equal(
      getGeneratorLaneValueType(createWorkflowNode("imageGenerator", 0)),
      "image",
    );
    assert.equal(
      getGeneratorLaneValueType(createWorkflowNode("videoGenerator", 0)),
      "video",
    );
    assert.equal(
      getGeneratorLaneValueType(createWorkflowNode("llmGenerator", 0)),
      "text",
    );
    assert.equal(
      getGeneratorLaneValueType(createWorkflowNode("prompt", 0)),
      null,
    );
  });

  test("credit quote excludes completed lane keys", () => {
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
        { completedLaneKeys: new Set(["llm:0", "llm:2"]) },
      ).totalCost,
      LLM_ESTIMATED_CREDIT_COST,
    );
  });
});
