import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Effect } from "effect";

import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import { executeWorkflow } from "~/lib/workflow/execution/core";
import type { NodeOutputArtifact } from "~/lib/workflow/execution/types";
import { GEMINI_3_FLASH_PREVIEW_MODEL_ID } from "~/lib/workflow/types";

describe("workflow execution output scope", () => {
  test("execution output filter wins over review continuation metadata", async () => {
    const list = {
      ...createWorkflowNode("list", 0),
      id: "list",
      items: ["output-zero", "output-one"],
    };
    const prompt = {
      ...createWorkflowNode("prompt", 1),
      id: "prompt",
      prompt: "{{variable1}}",
      variables: [{ key: "variable1", label: "Variable 1" }],
    };
    const llm = {
      ...createWorkflowNode("llmGenerator", 2),
      id: "llm",
    };
    const document: WorkflowDocument = {
      edges: [
        {
          id: "list-prompt",
          source: list.id,
          sourceHandle: "text",
          target: prompt.id,
          targetHandle: "variable1",
        },
        {
          id: "prompt-llm",
          source: prompt.id,
          sourceHandle: "text",
          target: llm.id,
          targetHandle: "prompt",
        },
      ],
      nodes: [list, prompt, llm],
      version: WORKFLOW_DOCUMENT_VERSION,
    };
    let generatedPrompt: string | null = null;

    await Effect.runPromise(
      executeWorkflow({
        ports: {
          generateImage: () => Effect.die("unexpected image generation"),
          generateVideo: () => Effect.die("unexpected video generation"),
          generateLlm: (request) => {
            generatedPrompt = request.prompt;
            return Effect.succeed({
              model: GEMINI_3_FLASH_PREVIEW_MODEL_ID,
              responseText: request.prompt,
              usage: {
                candidatesTokenCount: 0,
                promptTokenCount: 0,
                thoughtsTokenCount: 0,
                totalTokenCount: 0,
              },
            });
          },
          getNodeOutput: () => Effect.succeed(null),
          getNodeOutputValue: () => Effect.succeed(null),
        },
        request: {
          document,
          executionOutputFilter: { outputCount: 2, outputIndex: 0 },
          reviewOutputFilter: { outputIndex: 1, reviewNodeId: "review" },
          selection: { nodeIds: [llm.id] },
          target: { type: "selected-or-all" },
        },
        executionId: "run",
      }),
    );

    assert.equal(generatedPrompt, "output-zero");
  });

  test("cached output output matches only successful attempt and input hash", async () => {
    const list = {
      ...createWorkflowNode("list", 0),
      id: "list",
      items: ["prompt text"],
    };
    const prompt = {
      ...createWorkflowNode("prompt", 1),
      id: "prompt",
      prompt: "{{variable1}}",
      variables: [{ key: "variable1", label: "Variable 1" }],
    };
    const llm = {
      ...createWorkflowNode("llmGenerator", 2),
      id: "llm",
    };
    const document: WorkflowDocument = {
      edges: [
        {
          id: "list-prompt",
          source: list.id,
          sourceHandle: "text",
          target: prompt.id,
          targetHandle: "variable1",
        },
        {
          id: "prompt-llm",
          source: prompt.id,
          sourceHandle: "text",
          target: llm.id,
          targetHandle: "prompt",
        },
      ],
      nodes: [list, prompt, llm],
      version: WORKFLOW_DOCUMENT_VERSION,
    };
    const queries: { attempt: number; inputHash: string }[] = [];

    await Effect.runPromise(
      executeWorkflow({
        ports: {
          generateImage: () => Effect.die("unexpected image generation"),
          generateVideo: () => Effect.die("unexpected video generation"),
          generateLlm: () => Effect.die("unexpected llm generation"),
          getNodeOutput: (query) => {
            queries.push({
              attempt: query.attempt,
              inputHash: query.inputHash,
            });
            const cached = {
              attempt: query.attempt,
              documentRevision: null,
              idempotencyKey: "cache-hit",
              inputHash: query.inputHash,
              outputIndex: query.outputIndex,
              model: GEMINI_3_FLASH_PREVIEW_MODEL_ID,
              nodeId: query.nodeId,
              ownerUserId: "user",
              projectId: "project",
              promptSnapshot: null,
              reviewStatus: null,
              executionId: query.executionId,
              value: { items: ["cached text"], type: "text" },
            } satisfies NodeOutputArtifact;
            const rows = [
              { ...cached, status: "error" as const },
              {
                ...cached,
                attempt: query.attempt + 1,
                status: "success" as const,
              },
              { ...cached, inputHash: "other", status: "success" as const },
              { ...cached, status: "success" as const },
            ];
            return Effect.succeed(
              rows.find(
                (row) =>
                  row.status === "success" &&
                  row.attempt === query.attempt &&
                  row.inputHash === query.inputHash,
              ) ?? null,
            );
          },
          getNodeOutputValue: () => Effect.succeed(null),
        },
        request: {
          document,
          selection: { nodeIds: [llm.id] },
          target: { type: "selected-or-all" },
        },
        executionId: "run",
      }),
    );

    assert.deepEqual(
      queries.map((query) => query.attempt),
      [0],
    );
  });

  test("charges only provider-backed output execution", async () => {
    const prompt = {
      ...createWorkflowNode("prompt", 0),
      id: "prompt",
      prompt: "write",
      variables: [],
    };
    const llm = {
      ...createWorkflowNode("llmGenerator", 1),
      id: "llm",
    };
    const document: WorkflowDocument = {
      edges: [
        {
          id: "prompt-llm",
          source: prompt.id,
          sourceHandle: "text",
          target: llm.id,
          targetHandle: "prompt",
        },
      ],
      nodes: [prompt, llm],
      version: WORKFLOW_DOCUMENT_VERSION,
    };
    const charges: { idempotencyKey: string; inputHash: string }[] = [];

    const result = await Effect.runPromise(
      executeWorkflow({
        ports: {
          generateImage: () => Effect.die("unexpected image generation"),
          generateVideo: () => Effect.die("unexpected video generation"),
          generateLlm: () =>
            Effect.succeed({
              model: GEMINI_3_FLASH_PREVIEW_MODEL_ID,
              responseText: "done",
              usage: {
                candidatesTokenCount: 10,
                promptTokenCount: 10,
                thoughtsTokenCount: 0,
                totalTokenCount: 20,
              },
            }),
          getNodeOutput: () => Effect.succeed(null),
          getNodeOutputValue: () => Effect.succeed(null),
          onOutputCost: (charge) => {
            charges.push({
              idempotencyKey: charge.idempotencyKey,
              inputHash: charge.inputHash,
            });
            return Effect.succeed(7);
          },
        },
        request: {
          document,
          selection: { nodeIds: [llm.id] },
          target: { type: "selected-or-all" },
        },
        executionId: "run",
      }),
    );

    assert.equal(charges.length, 1);
    const charge = charges[0];
    assert.ok(charge);
    assert.equal(charge.idempotencyKey.startsWith("run:llm:0:0:"), true);
    assert.equal(charge.inputHash.length > 0, true);
    assert.equal(result.accruedCostCredits, 7);
  });
});
