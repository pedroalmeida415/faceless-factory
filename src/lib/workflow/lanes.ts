import type { WorkflowValueType } from "~/lib/workflow/node-definitions";
import type { LaneReorderMode, WorkflowAsset } from "~/lib/workflow/types";

export type TextRuntimeValue = {
  type: "text";
  lanes: string[];
};

export type MediaRuntimeValue = {
  type: "image" | "video";
  lanes: WorkflowAsset[][];
};

export type RuntimeValue = TextRuntimeValue | MediaRuntimeValue;

export type LanePermutation = number[];

export function getRuntimeValueLaneCount(value: RuntimeValue) {
  return value.lanes.length;
}

export function createIdentityLanePermutation(laneCount: number) {
  return Array.from({ length: laneCount }, (_, index) => index);
}

function normalizeShift(shift: number, laneCount: number) {
  if (laneCount <= 0) {
    return 0;
  }

  return ((shift % laneCount) + laneCount) % laneCount;
}

export function createShiftedLanePermutation(
  laneCount: number,
  shift: number,
): LanePermutation {
  const normalizedShift = normalizeShift(shift, laneCount);
  return Array.from(
    { length: laneCount },
    (_, index) => (index + normalizedShift) % laneCount,
  );
}

export function validateLanePermutation(
  permutation: readonly number[],
  laneCount: number,
): LanePermutation {
  const message = getLanePermutationValidationMessage(permutation, laneCount);
  if (message) {
    throw new Error(message);
  }

  return [...permutation];
}

export function getLanePermutationValidationMessage(
  permutation: readonly number[],
  laneCount: number,
) {
  if (permutation.length !== laneCount) {
    return "Lane order must include every upstream lane exactly once.";
  }

  const seen = new Set<number>();
  for (const index of permutation) {
    if (!Number.isInteger(index) || index < 0 || index >= laneCount) {
      return "Lane order contains an out-of-range lane index.";
    }

    if (seen.has(index)) {
      return "Lane order cannot contain duplicate lane indices.";
    }

    seen.add(index);
  }

  return null;
}

export function resolveLanePermutation(params: {
  laneCount: number;
  mode: LaneReorderMode;
  order: readonly number[];
  shift: number;
}) {
  return params.mode === "manual"
    ? validateLanePermutation(params.order, params.laneCount)
    : createShiftedLanePermutation(params.laneCount, params.shift);
}

function reorderArray<T>(values: readonly T[], permutation: readonly number[]) {
  return permutation
    .map((index) => values[index])
    .filter((value) => value !== undefined);
}

export function reorderRuntimeValue(
  value: RuntimeValue,
  permutation: readonly number[],
): RuntimeValue {
  const order = validateLanePermutation(permutation, value.lanes.length);

  switch (value.type) {
    case "text":
      return {
        type: value.type,
        lanes: reorderArray(value.lanes, order),
      };
    case "image":
    case "video":
      return {
        type: value.type,
        lanes: reorderArray(value.lanes, order),
      };
  }
}

export function isWorkflowValueType(
  value: unknown,
): value is WorkflowValueType {
  return value === "text" || value === "image" || value === "video";
}
