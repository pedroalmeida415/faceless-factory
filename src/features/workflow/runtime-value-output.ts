import type { RuntimeValue } from "~/features/workflow/runtime-values";

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
