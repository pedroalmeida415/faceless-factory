import { z } from "zod";

const WorkflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const WorkflowListNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("list"),
  position: WorkflowPositionSchema,
  data: z.object({
    items: z.array(
      z.object({
        id: z.string().min(1),
        text: z.string(),
      }),
    ),
  }),
});

export type WorkflowListNode = z.infer<typeof WorkflowListNodeSchema>;

export function createDefaultWorkflowListNodeData(): WorkflowListNode["data"] {
  return { items: [{ id: `item-${crypto.randomUUID()}`, text: "" }] };
}

export function getWorkflowListTextValues(node: WorkflowListNode) {
  return node.data.items.map((item) => item.text.trim()).filter(Boolean);
}

export function getWorkflowListDisplayValue(node: WorkflowListNode) {
  const items = getWorkflowListTextValues(node);

  if (items.length > 1) {
    return `${items.length} branches`;
  }

  return items[0] ?? null;
}
