export {
  buildIncomingByTarget,
  type GeneratorIterationInfo,
  getGeneratorInputHandles,
  getGeneratorIterationPreview,
  type RuntimeValue,
} from "~/lib/workflow/graph";
export {
  formatNodeTitle,
  type HandleDefinition,
  PROMPT_INPUT_HANDLE_ID,
} from "~/lib/workflow/node-definitions";

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
