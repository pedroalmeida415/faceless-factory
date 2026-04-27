import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Effect } from "effect";

import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import { executeWorkflow } from "~/lib/workflow/execution/core";
import { GEMINI_3_FLASH_PREVIEW_MODEL_ID } from "~/lib/workflow/types";

describe("workflow execution lane scope", () => {
  test("execution lane filter wins over review continuation metadata", async () => {
    const list = {
      ...createWorkflowNode("list", 0),
      id: "list",
      items: ["lane-zero", "lane-one"],
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
          getNodeLaneOutput: () => Effect.succeed(null),
          getNodeLaneValue: () => Effect.succeed(null),
        },
        request: {
          document,
          executionLaneFilter: { laneCount: 2, laneIndex: 0 },
          reviewLaneFilter: { laneIndex: 1, reviewNodeId: "review" },
          selection: { nodeIds: [llm.id] },
          target: { type: "selected-or-all" },
        },
        runId: "run",
      }),
    );

    assert.equal(generatedPrompt, "lane-zero");
  });
});
