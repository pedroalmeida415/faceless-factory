export {
  type GeneratorIterationInfo,
  getGeneratorIterationPreview,
} from "~/features/runtime/materialization/subgraph";
export { getGeneratorInputHandles } from "~/features/workflow/graph";
export type { HandleDefinition } from "~/features/workflow/node-definitions";

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
