import { z } from "zod";
import type { WorkflowEdge, WorkflowNode } from "~/features/workflow/domain/graph";
import { getWorkflowListDisplayValue } from "~/features/workflow/domain/nodes/list";

const WorkflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const PROMPT_VARIABLE_INPUT_CAPACITY = 50;
export const PROMPT_VARIABLES_TARGET_HANDLE = "variables";

export type WorkflowPromptDocument = {
  attrs?: Record<string, unknown>;
  content?: WorkflowPromptDocument[];
  marks?: { attrs?: Record<string, unknown>; type: string }[];
  text?: string;
  type?: string;
};

export const WorkflowPromptDocumentSchema: z.ZodType<WorkflowPromptDocument> = z.lazy(() =>
  z.object({
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(WorkflowPromptDocumentSchema).optional(),
    marks: z.array(z.object({ attrs: z.record(z.string(), z.unknown()).optional(), type: z.string() })).optional(),
    text: z.string().optional(),
    type: z.string().optional(),
  }),
);

export const WorkflowPromptNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("prompt"),
  position: WorkflowPositionSchema,
  data: z.preprocess(
    (value) => {
      if (!value || typeof value !== "object") {
        return value;
      }

      if ("document" in value) {
        return value;
      }

      if ("text" in value && typeof value.text === "string") {
        return { document: createPromptDocumentFromText(value.text) };
      }

      return value;
    },
    z.object({
      document: WorkflowPromptDocumentSchema,
    }),
  ),
});

export type WorkflowPromptNode = z.infer<typeof WorkflowPromptNodeSchema>;

export type WorkflowPromptVariable = {
  readonly displayText: string;
  readonly id: string;
  readonly label: string;
  readonly source?: string | null;
  readonly value?: string | null;
};

export const EMPTY_PROMPT_DOCUMENT = createPromptDocumentFromText("");

export function createDefaultWorkflowPromptNodeData(): WorkflowPromptNode["data"] {
  return { document: EMPTY_PROMPT_DOCUMENT };
}

export function createPromptDocumentFromText(text: string): WorkflowPromptDocument {
  return {
    content: [
      {
        content: text ? [{ text, type: "text" }] : undefined,
        type: "paragraph",
      },
    ],
    type: "doc",
  };
}

export function renderPromptDocumentText(
  document: WorkflowPromptDocument,
  resolveMention: (variableId: string, fallbackLabel: string) => string,
) {
  return renderPromptNode(document, resolveMention);
}

export function getPromptDocumentMentionedVariableIds(document: WorkflowPromptDocument) {
  const ids = new Set<string>();
  collectMentionedVariableIds(document, ids);
  return ids;
}

export function getWorkflowPromptVariables(input: {
  readonly edges: readonly WorkflowEdge[];
  readonly nodes: readonly WorkflowNode[];
  readonly promptNodeId: string;
}): readonly WorkflowPromptVariable[] {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));

  return input.edges
    .filter((edge) => edge.target === input.promptNodeId && edge.targetHandle === PROMPT_VARIABLES_TARGET_HANDLE)
    .map((edge) => getWorkflowPromptVariable({ sourceNode: nodesById.get(edge.source), sourceNodeId: edge.source }));
}

function getWorkflowPromptVariable(input: {
  readonly sourceNode: WorkflowNode | undefined;
  readonly sourceNodeId: string;
}): WorkflowPromptVariable {
  const display = getVariableDisplay(input.sourceNode);
  const label = display.source ?? "Connected text";
  const displayText = display.value ?? "No value";

  return {
    displayText,
    id: input.sourceNodeId,
    label,
    source: label,
    value: display.value,
  };
}

function getVariableDisplay(node: WorkflowNode | undefined): {
  readonly source: string | null;
  readonly value: string | null;
} {
  if (!node) {
    return { source: null, value: null };
  }

  if (node.type === "prompt") {
    return { source: "Prompt", value: renderPromptDocumentText(node.data.document, () => "").trim() || null };
  }

  if (node.type === "list") {
    return { source: "List", value: getWorkflowListDisplayValue(node) };
  }

  return { source: "Connected text", value: null };
}

function renderPromptNode(
  node: WorkflowPromptDocument,
  resolveMention: (variableId: string, fallbackLabel: string) => string,
): string {
  if (node.type === "text") {
    return node.text ?? "";
  }

  if (node.type === "mention") {
    const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
    const label = typeof node.attrs?.label === "string" ? node.attrs.label : id;

    return id ? resolveMention(id, label) : "";
  }

  const childText = node.content?.map((child) => renderPromptNode(child, resolveMention)).join("") ?? "";

  if (node.type === "doc") {
    return node.content?.map((child) => renderPromptNode(child, resolveMention)).join("\n") ?? "";
  }

  return childText;
}

function collectMentionedVariableIds(node: WorkflowPromptDocument, ids: Set<string>) {
  if (node.type === "mention" && typeof node.attrs?.id === "string") {
    ids.add(node.attrs.id);
  }

  for (const child of node.content ?? []) {
    collectMentionedVariableIds(child, ids);
  }
}
