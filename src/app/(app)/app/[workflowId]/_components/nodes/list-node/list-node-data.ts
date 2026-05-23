import type { WorkflowListNode } from "~/features/workflow/domain/graph";

export function createTextListDataWithEditableBlank(data: WorkflowListNode["data"]): {
  readonly data: WorkflowListNode["data"];
  readonly itemId: string;
} {
  const nextData = structuredClone(data);
  nextData.mode = "text";

  const blankItem = nextData.items.find((item) => item.text.trim() === "");

  if (blankItem) {
    return { data: nextData, itemId: blankItem.id };
  }

  const itemId = `item-${crypto.randomUUID()}`;
  nextData.items.push({ id: itemId, text: "" });

  return { data: nextData, itemId };
}
