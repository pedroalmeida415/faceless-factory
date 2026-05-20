import { describe, expect, test } from "bun:test";
import {
  createWorkflowGraph,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from "~/features/workflow/domain/graph";
import { createWorkflowNode, isWorkflowConnectionAllowed } from "~/features/workflow/domain/graph-editing";
import { evaluateGenerationNode } from "~/features/workflow/domain/graph-evaluation";
import {
  createPromptDocumentFromText,
  getWorkflowPromptVariables,
  PROMPT_VARIABLES_TARGET_HANDLE,
} from "~/features/workflow/domain/nodes/prompt";

type PromptMention = { readonly id: string; readonly label: string };

describe("workflow input alignment", () => {
  test("evaluates Prompt to Image Generation as one Branch with one image", () => {
    const evaluation = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("prompt-1", "gen-1", "prompt")],
        nodes: [promptNode("prompt-1", "a cinematic fox"), imageGenerationNode("gen-1")],
      }),
      nodeId: "gen-1",
    });

    expect(evaluation.summary).toEqual({
      branchBatchSize: 1,
      branchCount: 1,
      generationCostCredits: 1,
      status: "valid",
      totalOutputCount: 1,
    });
    expect(evaluation.branches).toEqual([
      {
        branchIndex: 0,
        inputs: [
          { edgeId: "edge-prompt-1-gen-1-prompt", ref: { kind: "text", value: "a cinematic fox" }, socketId: "prompt" },
        ],
      },
    ]);
  });

  test("uses List items as ordered Branch text values", () => {
    const evaluation = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("list-1", "gen-1", "prompt")],
        nodes: [listNode("list-1", ["first", "second", "third"]), imageGenerationNode("gen-1")],
      }),
      nodeId: "gen-1",
    });

    expect(evaluation.summary.branchCount).toBe(3);
    expect(evaluation.branches.map((branch) => branch.inputs[0]?.ref)).toEqual([
      { kind: "text", value: "first" },
      { kind: "text", value: "second" },
      { kind: "text", value: "third" },
    ]);
  });

  test("splices Prompt variables from connected text inputs", () => {
    const evaluation = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("list-1", "prompt-1", PROMPT_VARIABLES_TARGET_HANDLE), edge("prompt-1", "gen-1", "prompt")],
        nodes: [
          promptNode("prompt-1", "A @List product shot", [{ id: "list-1", label: "List" }]),
          listNode("list-1", ["noir", "chrome"]),
          imageGenerationNode("gen-1"),
        ],
      }),
      nodeId: "gen-1",
    });

    expect(evaluation.summary.branchCount).toBe(2);
    expect(evaluation.branches.map((branch) => branch.inputs[0]?.ref)).toEqual([
      { kind: "text", value: "A noir product shot" },
      { kind: "text", value: "A chrome product shot" },
    ]);
  });

  test("keeps unconnected Prompt variables from affecting output", () => {
    const evaluation = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("list-1", "prompt-1", PROMPT_VARIABLES_TARGET_HANDLE), edge("prompt-1", "gen-1", "prompt")],
        nodes: [
          promptNode("prompt-1", "Static @Missing prompt", [{ id: "missing-source", label: "Missing" }]),
          listNode("list-1", ["first", "second"]),
          imageGenerationNode("gen-1"),
        ],
      }),
      nodeId: "gen-1",
    });

    expect(evaluation.summary.branchCount).toBe(1);
    expect(evaluation.branches[0]?.inputs[0]?.ref).toEqual({ kind: "text", value: "Static  prompt" });
  });

  test("projects connected Prompt variable options from graph inputs", () => {
    const variables = getWorkflowPromptVariables({
      edges: [
        edge("list-1", "prompt-1", PROMPT_VARIABLES_TARGET_HANDLE),
        edge("prompt-2", "prompt-1", PROMPT_VARIABLES_TARGET_HANDLE),
      ],
      nodes: [
        promptNode("prompt-1", "A @List product shot"),
        listNode("list-1", ["noir", "chrome"]),
        promptNode("prompt-2", "seed prompt"),
      ],
      promptNodeId: "prompt-1",
    });

    expect(variables).toEqual([
      { displayText: "2 branches", id: "list-1", label: "List", source: "List", value: "2 branches" },
      { displayText: "seed prompt", id: "prompt-2", label: "Prompt", source: "Prompt", value: "seed prompt" },
    ]);
  });

  test("broadcasts a single Asset across List Branches", () => {
    const evaluation = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("list-1", "gen-1", "prompt"), edge("asset-1", "gen-1", "image")],
        nodes: [
          listNode("list-1", ["first", "second", "third"]),
          assetNode("asset-1", ["asset-a"]),
          imageGenerationNode("gen-1"),
        ],
      }),
      nodeId: "gen-1",
    });

    const imageState = evaluation.inputStates.find((inputState) => inputState.socketId === "image");

    expect(evaluation.summary.branchCount).toBe(3);
    expect(imageState?.status).toBe("broadcasting");
    expect(evaluation.branches.map((branch) => branch.inputs.find((input) => input.socketId === "image")?.ref)).toEqual(
      [
        { assetId: "asset-a", kind: "asset" },
        { assetId: "asset-a", kind: "asset" },
        { assetId: "asset-a", kind: "asset" },
      ],
    );
  });

  test("zips List and Asset arrays by order", () => {
    const evaluation = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("list-1", "gen-1", "prompt"), edge("asset-1", "gen-1", "image")],
        nodes: [
          listNode("list-1", ["first", "second", "third"]),
          assetNode("asset-1", ["asset-a", "asset-b", "asset-c"]),
          imageGenerationNode("gen-1"),
        ],
      }),
      nodeId: "gen-1",
    });

    expect(evaluation.summary.branchCount).toBe(3);
    expect(evaluation.branches.map((branch) => branch.inputs.find((input) => input.socketId === "image")?.ref)).toEqual(
      [
        { assetId: "asset-a", kind: "asset" },
        { assetId: "asset-b", kind: "asset" },
        { assetId: "asset-c", kind: "asset" },
      ],
    );
  });

  test("blocks mismatched non-single arrays", () => {
    const evaluation = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("list-1", "gen-1", "prompt"), edge("asset-1", "gen-1", "image")],
        nodes: [
          listNode("list-1", ["first", "second"]),
          assetNode("asset-1", ["asset-a", "asset-b", "asset-c"]),
          imageGenerationNode("gen-1"),
        ],
      }),
      nodeId: "gen-1",
    });

    expect(evaluation.summary.status).toBe("blocked");
    expect(evaluation.errors.map((error) => error.kind)).toContain("input-alignment-mismatch");
  });

  test("ignores optional No Value inputs for alignment while keeping capacity usage", () => {
    const evaluation = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("list-1", "gen-1", "prompt"), edge("asset-1", "gen-1", "image")],
        nodes: [
          listNode("list-1", ["first", "second", "third"]),
          assetNode("asset-1", []),
          imageGenerationNode("gen-1"),
        ],
      }),
      nodeId: "gen-1",
    });
    const imageState = evaluation.inputStates.find((inputState) => inputState.socketId === "image");

    expect(evaluation.summary.status).toBe("valid");
    expect(evaluation.summary.branchCount).toBe(3);
    expect(imageState?.connectedEdgeCount).toBe(1);
    expect(imageState?.status).toBe("ignored-optional-no-value");
  });

  test("blocks missing required Prompt input for no edge, empty Prompt, and blank-only List", () => {
    const noPrompt = evaluateGenerationNode({
      blueprint: graph({ nodes: [imageGenerationNode("gen-1")] }),
      nodeId: "gen-1",
    });
    const emptyPrompt = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("prompt-1", "gen-1", "prompt")],
        nodes: [promptNode("prompt-1", " "), imageGenerationNode("gen-1")],
      }),
      nodeId: "gen-1",
    });
    const blankList = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("list-1", "gen-1", "prompt")],
        nodes: [listNode("list-1", ["", " "]), imageGenerationNode("gen-1")],
      }),
      nodeId: "gen-1",
    });

    expect(noPrompt.errors.map((error) => error.kind)).toContain("missing-required-input");
    expect(emptyPrompt.errors.map((error) => error.kind)).toContain("missing-required-input");
    expect(blankList.errors.map((error) => error.kind)).toContain("missing-required-input");
  });

  test("enforces max Branch Count of 50", () => {
    const valid = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("list-1", "gen-1", "prompt")],
        nodes: [listNode("list-1", numberedItems(50)), imageGenerationNode("gen-1")],
      }),
      nodeId: "gen-1",
    });
    const invalid = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("list-1", "gen-1", "prompt")],
        nodes: [listNode("list-1", numberedItems(51)), imageGenerationNode("gen-1")],
      }),
      nodeId: "gen-1",
    });

    expect(valid.summary.status).toBe("valid");
    expect(valid.summary.branchCount).toBe(50);
    expect(invalid.summary.status).toBe("blocked");
    expect(invalid.errors.map((error) => error.kind)).toContain("branch-count-exceeded");
  });

  test("blocks incompatible edge data types", () => {
    const evaluation = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("prompt-1", "gen-1", "image")],
        nodes: [promptNode("prompt-1", "not an image"), imageGenerationNode("gen-1")],
      }),
      nodeId: "gen-1",
    });

    expect(evaluation.summary.status).toBe("blocked");
    expect(evaluation.errors.map((error) => error.kind)).toContain("type-mismatch");
  });

  test("computes total output count and Generation Cost from Branch Count and Batch size", () => {
    const evaluation = evaluateGenerationNode({
      blueprint: graph({
        edges: [edge("list-1", "gen-1", "prompt")],
        nodes: [listNode("list-1", ["first", "second", "third"]), imageGenerationNode("gen-1", { branchBatchSize: 4 })],
      }),
      nodeId: "gen-1",
    });

    expect(evaluation.summary.totalOutputCount).toBe(12);
    expect(evaluation.summary.generationCostCredits).toBe(12);
  });
});

describe("workflow graph editing", () => {
  test("creates default node data in the workflow domain", () => {
    const listNode = createWorkflowNode({ position: { x: 10, y: 20 }, type: "list" });

    expect(listNode).toMatchObject({
      data: { items: [{ text: "" }] },
      position: { x: 10, y: 20 },
      type: "list",
    });
    expect(listNode.id).toMatch(/^list-/);
    expect(listNode.type === "list" ? listNode.data.items[0]?.id : "").toMatch(/^item-/);
    expect(createWorkflowNode({ position: { x: 0, y: 0 }, type: "prompt" }).data).toEqual({
      document: createPromptDocumentFromText(""),
    });

    expect(createWorkflowNode({ position: { x: 0, y: 0 }, type: "imageGeneration" }).data).toEqual({
      branchBatchSize: 1,
      config: { resolution: "1080p" },
      modelId: "nano-banana-pro",
      selectedBatchItems: [],
    });
  });

  test("allows only connections matching target socket data type and capacity", () => {
    const nodes = [promptNode("prompt-1", "prompt"), assetNode("asset-1", ["asset-1"]), imageGenerationNode("gen-1")];
    const imageEdges = [edge("asset-a", "gen-1", "image"), edge("asset-b", "gen-1", "image")];

    expect(
      isWorkflowConnectionAllowed({
        connection: { source: "prompt-1", target: "gen-1", targetHandle: "prompt" },
        edges: [],
        nodes,
      }),
    ).toBe(true);
    expect(
      isWorkflowConnectionAllowed({
        connection: { source: "prompt-1", target: "gen-1", targetHandle: "image" },
        edges: [],
        nodes,
      }),
    ).toBe(false);
    expect(
      isWorkflowConnectionAllowed({
        connection: { source: "asset-1", target: "gen-1", targetHandle: "image" },
        edges: imageEdges,
        nodes,
      }),
    ).toBe(true);
    expect(
      isWorkflowConnectionAllowed({
        connection: { source: "asset-1", target: "gen-1", targetHandle: "image" },
        edges: [...imageEdges, edge("asset-c", "gen-1", "image")],
        nodes,
      }),
    ).toBe(false);
  });

  test("allows primitive text connections into the Prompt variables socket up to capacity", () => {
    const prompt = promptNode("prompt-1", "A @List prompt", [{ id: "list-1", label: "List" }]);
    const nodes = [prompt, listNode("list-1", ["noir"]), assetNode("asset-1", ["asset-1"])];

    expect(
      isWorkflowConnectionAllowed({
        connection: { source: "list-1", target: "prompt-1", targetHandle: PROMPT_VARIABLES_TARGET_HANDLE },
        edges: [],
        nodes,
      }),
    ).toBe(true);
    expect(
      isWorkflowConnectionAllowed({
        connection: { source: "asset-1", target: "prompt-1", targetHandle: PROMPT_VARIABLES_TARGET_HANDLE },
        edges: [],
        nodes,
      }),
    ).toBe(false);
    expect(
      isWorkflowConnectionAllowed({
        connection: { source: "list-1", target: "prompt-1", targetHandle: PROMPT_VARIABLES_TARGET_HANDLE },
        edges: Array.from({ length: 50 }, (_, index) =>
          edge(`list-${index}`, "prompt-1", PROMPT_VARIABLES_TARGET_HANDLE),
        ),
        nodes,
      }),
    ).toBe(false);
  });

  test("stamps graph schema version when building a persisted graph", () => {
    expect(createWorkflowGraph({ edges: [], nodes: [] })).toEqual({ edges: [], nodes: [], schemaVersion: 1 });
  });
});

function graph(input: {
  readonly edges?: readonly WorkflowEdge[];
  readonly nodes: readonly WorkflowNode[];
}): WorkflowGraph {
  return {
    edges: [...(input.edges ?? [])],
    nodes: [...input.nodes],
    schemaVersion: 1,
  };
}

function promptNode(id: string, text: string, mentions: readonly PromptMention[]): WorkflowNode;
function promptNode(id: string, text: string): WorkflowNode;
function promptNode(id: string, text: string, mentions: readonly PromptMention[] = []): WorkflowNode {
  const content = createPromptContent(text, mentions);

  return {
    data: {
      document: { content: [{ content, type: "paragraph" }], type: "doc" },
    },
    id,
    position: { x: 0, y: 0 },
    type: "prompt",
  };
}

function createPromptContent(text: string, mentions: readonly PromptMention[]) {
  const content: NonNullable<ReturnType<typeof createPromptDocumentFromText>["content"]>[number]["content"] = [];
  let remaining = text;

  while (remaining) {
    const nextMention = mentions
      .map((mention) => ({ index: remaining.indexOf(`@${mention.label}`), mention }))
      .filter((candidate) => candidate.index >= 0)
      .sort((left, right) => left.index - right.index)[0];

    if (!nextMention) {
      content.push({ text: remaining, type: "text" });
      break;
    }

    if (nextMention.index > 0) {
      content.push({ text: remaining.slice(0, nextMention.index), type: "text" });
    }

    content.push({ attrs: { id: nextMention.mention.id, label: nextMention.mention.label }, type: "mention" });
    remaining = remaining.slice(nextMention.index + nextMention.mention.label.length + 1);
  }

  return content;
}

function listNode(id: string, items: readonly string[]): WorkflowNode {
  return {
    data: {
      items: items.map((text, index) => ({ id: `${id}-item-${index}`, text })),
    },
    id,
    position: { x: 0, y: 0 },
    type: "list",
  };
}

function assetNode(id: string, assets: readonly string[]): WorkflowNode {
  return {
    data: {
      assets: assets.map((assetId) => ({ assetId })),
    },
    id,
    position: { x: 0, y: 0 },
    type: "asset",
  };
}

function imageGenerationNode(id: string, options?: { readonly branchBatchSize?: number }): WorkflowNode {
  return {
    data: {
      branchBatchSize: options?.branchBatchSize ?? 1,
      config: { resolution: "1080p" },
      modelId: "nano-banana-pro",
      selectedBatchItems: [],
    },
    id,
    position: { x: 0, y: 0 },
    type: "imageGeneration",
  };
}

function edge(source: string, target: string, targetHandle: string): WorkflowEdge {
  return {
    id: `edge-${source}-${target}-${targetHandle}`,
    source,
    target,
    targetHandle,
  };
}

function numberedItems(count: number) {
  return Array.from({ length: count }, (_, index) => `item ${index + 1}`);
}
