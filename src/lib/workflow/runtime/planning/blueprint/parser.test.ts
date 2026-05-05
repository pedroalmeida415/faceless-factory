import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
} from "~/lib/workflow/document";
import { parseWorkflowBlueprint } from "~/lib/workflow/runtime/planning/blueprint/parser";

function makeNode(kind: Parameters<typeof createWorkflowNode>[0], id: string) {
  const node = {
    ...createWorkflowNode(kind, 0),
    id,
  };

  return node.kind === "prompt"
    ? {
        ...node,
        prompt: "{{variable1}}",
        variables: [{ key: "variable1", label: "Variable 1" }],
      }
    : node;
}

function makeDocument(): WorkflowDocument {
  return {
    version: WORKFLOW_DOCUMENT_VERSION,
    nodes: [
      makeNode("list", "topic"),
      makeNode("prompt", "prompt-a"),
      makeNode("prompt", "prompt-b"),
      makeNode("llmGenerator", "script"),
    ],
    edges: [
      {
        id: "topic-to-prompt-a",
        source: "topic",
        sourceHandle: "text",
        target: "prompt-a",
        targetHandle: "variable1",
      },
      {
        id: "topic-to-prompt-b",
        source: "topic",
        sourceHandle: "text",
        target: "prompt-b",
        targetHandle: "variable1",
      },
      {
        id: "prompt-b-to-script",
        source: "prompt-b",
        sourceHandle: "text",
        target: "script",
        targetHandle: "prompt",
      },
      {
        id: "prompt-a-to-script",
        source: "prompt-a",
        sourceHandle: "text",
        target: "script",
        targetHandle: "prompt",
      },
      {
        id: "prompt-a-to-script-system",
        source: "prompt-a",
        sourceHandle: "text",
        target: "script",
        targetHandle: "systemPrompt",
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

describe("workflow blueprint parser", () => {
  test("answers deterministic sorted unique parent node ids", () => {
    const blueprint = unwrap(parseWorkflowBlueprint(makeDocument()));

    assert.deepEqual(unwrap(blueprint.getParentNodeIds("script")), [
      "prompt-a",
      "prompt-b",
    ]);
  });

  test("answers deterministic sorted dependency addresses for parent handles", () => {
    const blueprint = unwrap(parseWorkflowBlueprint(makeDocument()));

    assert.deepEqual(unwrap(blueprint.getParentDependencyAddresses("script")), [
      {
        sourceHandle: "text",
        sourceNodeId: "prompt-a",
        targetHandle: "prompt",
        targetNodeId: "script",
      },
      {
        sourceHandle: "text",
        sourceNodeId: "prompt-a",
        targetHandle: "systemPrompt",
        targetNodeId: "script",
      },
      {
        sourceHandle: "text",
        sourceNodeId: "prompt-b",
        targetHandle: "prompt",
        targetNodeId: "script",
      },
    ]);
  });

  test("answers deterministic sorted unique child node ids", () => {
    const blueprint = unwrap(parseWorkflowBlueprint(makeDocument()));

    assert.deepEqual(unwrap(blueprint.getChildNodeIds("topic")), [
      "prompt-a",
      "prompt-b",
    ]);
  });

  test("reports missing node ids as blueprint validation errors", () => {
    const blueprint = unwrap(parseWorkflowBlueprint(makeDocument()));
    const result = blueprint.getParentNodeIds("missing");

    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
      _tag: "WorkflowBlueprintValidationError",
      message: "Workflow blueprint is missing node missing.",
    });
  });

  test("reports edges that address missing nodes as blueprint validation errors", () => {
    const document = makeDocument();
    const result = parseWorkflowBlueprint({
      ...document,
      edges: [
        ...document.edges,
        {
          id: "missing-to-script",
          source: "missing",
          sourceHandle: "text",
          target: "script",
          targetHandle: "prompt",
        },
      ],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
      _tag: "WorkflowBlueprintValidationError",
      message:
        "Workflow blueprint contains a dependency address to a missing node.",
    });
  });

  test("reports cyclic dependency addresses as blueprint validation errors", () => {
    const document = makeDocument();
    const result = parseWorkflowBlueprint({
      ...document,
      nodes: [makeNode("prompt", "first"), makeNode("prompt", "second")],
      edges: [
        {
          id: "first-to-second",
          source: "first",
          sourceHandle: "text",
          target: "second",
          targetHandle: "variable1",
        },
        {
          id: "second-to-first",
          source: "second",
          sourceHandle: "text",
          target: "first",
          targetHandle: "variable1",
        },
      ],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
      _tag: "WorkflowBlueprintValidationError",
      message: "Workflow blueprint contains a dependency cycle.",
    });
  });

  test("answers upstream closure in topological dependency order", () => {
    const blueprint = unwrap(parseWorkflowBlueprint(makeDocument()));

    assert.deepEqual(unwrap(blueprint.getUpstreamClosureNodeIds("script")), [
      "topic",
      "prompt-a",
      "prompt-b",
    ]);
  });

  test("answers downstream closure in topological order away from the source", () => {
    const blueprint = unwrap(parseWorkflowBlueprint(makeDocument()));

    assert.deepEqual(unwrap(blueprint.getDownstreamClosureNodeIds("topic")), [
      "prompt-a",
      "prompt-b",
      "script",
    ]);
  });
});
