import type { RuntimeValue } from "~/lib/workflow/lanes";
import type { WorkflowAsset } from "~/lib/workflow/types";

export function replaceMediaOutputLane(
  outputLanes: readonly WorkflowAsset[][],
  laneIndex: number,
  assets: WorkflowAsset[],
) {
  const nextOutputLanes = Array.from(
    { length: Math.max(outputLanes.length, laneIndex + 1) },
    (_, index) => outputLanes[index] ?? [],
  );
  nextOutputLanes[laneIndex] = assets;
  return nextOutputLanes;
}

export function replaceTextOutputLane(
  outputLanes: readonly string[],
  laneIndex: number,
  text: string,
) {
  const nextOutputLanes = Array.from(
    { length: Math.max(outputLanes.length, laneIndex + 1) },
    (_, index) => outputLanes[index] ?? "",
  );
  nextOutputLanes[laneIndex] = text;
  return nextOutputLanes;
}

export function getRuntimeValueLane(
  value: RuntimeValue,
  laneIndex: number,
): RuntimeValue | null {
  switch (value.type) {
    case "text": {
      const text = value.lanes[laneIndex]?.trim();
      return text ? { type: "text", lanes: [text] } : null;
    }
    case "image":
    case "video": {
      const assets = value.lanes[laneIndex] ?? [];
      return assets.length ? { type: value.type, lanes: [assets] } : null;
    }
  }
}
