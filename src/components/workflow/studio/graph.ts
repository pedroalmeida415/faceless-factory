export {
  type GeneratorIterationInfo,
  getGeneratorIterationPreview,
} from "~/lib/workflow/execution/subgraph";
export { getGeneratorInputHandles } from "~/lib/workflow/graph";
export type { HandleDefinition } from "~/lib/workflow/node-definitions";

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]',
    ),
  );
}
