import type { RuntimeValue } from "~/lib/workflow/runtime-values";
import type { WorkflowAsset } from "~/lib/workflow/types";

export function replaceMediaOutputOutput(
  outputs: readonly WorkflowAsset[][],
  outputIndex: number,
  assets: WorkflowAsset[],
) {
  const nextOutputs = Array.from(
    { length: Math.max(outputs.length, outputIndex + 1) },
    (_, index) => outputs[index] ?? [],
  );
  nextOutputs[outputIndex] = assets;
  return nextOutputs;
}

export function replaceTextOutputOutput(
  outputs: readonly string[],
  outputIndex: number,
  text: string,
) {
  const nextOutputs = Array.from(
    { length: Math.max(outputs.length, outputIndex + 1) },
    (_, index) => outputs[index] ?? "",
  );
  nextOutputs[outputIndex] = text;
  return nextOutputs;
}

export function getRuntimeValueOutput(
  value: RuntimeValue,
  outputIndex: number,
): RuntimeValue | null {
  switch (value.type) {
    case "text": {
      const text = value.items[outputIndex]?.trim();
      return text ? { type: "text", items: [text] } : null;
    }
    case "image":
    case "video": {
      const assets = value.items[outputIndex] ?? [];
      return assets.length ? { type: value.type, items: [assets] } : null;
    }
  }
}
