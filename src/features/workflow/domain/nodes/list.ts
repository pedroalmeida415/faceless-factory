import { z } from "zod";
import type { WorkflowDataType } from "~/features/workflow/domain/model-catalog";

const WorkflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const WorkflowListNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("list"),
  position: WorkflowPositionSchema,
  data: z.object({
    mode: z.enum(["text", "media"]).nullable().optional(),
    items: z.array(
      z.object({
        id: z.string().min(1),
        text: z.string(),
      }),
    ),
  }),
});

export type WorkflowListNode = z.infer<typeof WorkflowListNodeSchema>;
export type WorkflowListMode = NonNullable<WorkflowListNode["data"]["mode"]>;

export function createDefaultWorkflowListNodeData(): WorkflowListNode["data"] {
  return { items: [], mode: null };
}

export function getWorkflowListDataMode(data: WorkflowListNode["data"]): WorkflowListMode | null {
  if (data.mode === "text" || data.mode === "media") {
    return data.mode;
  }

  return data.items.some((item) => item.text.trim() !== "") ? "text" : null;
}

export function getWorkflowListMode(node: WorkflowListNode): WorkflowListMode | null {
  return getWorkflowListDataMode(node.data);
}

export function getWorkflowListOutputDataType(node: WorkflowListNode): WorkflowDataType | null {
  const mode = getWorkflowListMode(node);

  if (mode === "text") {
    return "text";
  }

  return null;
}

export function getWorkflowListTextValues(node: WorkflowListNode) {
  if (getWorkflowListMode(node) !== "text") {
    return [];
  }

  return node.data.items.map((item) => item.text.trim()).filter(Boolean);
}

export function getWorkflowListDisplayValue(node: WorkflowListNode) {
  const items = getWorkflowListTextValues(node);

  if (items.length > 1) {
    return `${items.length} branches`;
  }

  return items[0] ?? null;
}
