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

export function getAlignedLaneCount(counts: readonly number[]) {
  const laneCounts = counts.filter((count) => count > 0);
  if (!laneCounts.length) {
    return 1;
  }

  const laneCount = Math.max(...laneCounts);
  const mismatchedCount = laneCounts.find(
    (count) => count !== 1 && count !== laneCount,
  );

  if (mismatchedCount !== undefined) {
    throw new Error("Connected input lane counts do not match.");
  }

  return laneCount;
}

export function getBroadcastLane<T>(lanes: readonly T[], index: number) {
  return lanes.length === 1 ? lanes[0] : lanes[index];
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

export function getLaneSelectionValidationMessage(
  indices: readonly number[],
  laneCount: number,
) {
  if (!indices.length) {
    return "Lane selection must include at least one lane.";
  }

  const seen = new Set<number>();
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= laneCount) {
      return "Lane selection contains an out-of-range lane index.";
    }
    if (seen.has(index)) {
      return "Lane selection cannot contain duplicate lane indices.";
    }
    seen.add(index);
  }

  return null;
}

export function selectRuntimeValue(
  value: RuntimeValue,
  indices: readonly number[],
): RuntimeValue {
  const message = getLaneSelectionValidationMessage(
    indices,
    value.lanes.length,
  );
  if (message) {
    throw new Error(message);
  }

  switch (value.type) {
    case "text":
      return { type: value.type, lanes: reorderArray(value.lanes, indices) };
    case "image":
    case "video":
      return { type: value.type, lanes: reorderArray(value.lanes, indices) };
  }
}

export function splitRuntimeValueLane(
  value: RuntimeValue,
  index: number,
): RuntimeValue | null {
  switch (value.type) {
    case "text": {
      const lane = value.lanes[index];
      if (lane === undefined) {
        return null;
      }
      return { type: value.type, lanes: [lane] };
    }
    case "image":
    case "video": {
      const lane = value.lanes[index];
      if (lane === undefined) {
        return null;
      }
      return { type: value.type, lanes: [lane] };
    }
  }
}

export function getLaneSplitValidationMessage(
  splitCount: number,
  laneCount: number,
) {
  if (!Number.isInteger(splitCount) || splitCount < 1) {
    return "Lane split count must be at least one.";
  }

  if (splitCount > laneCount) {
    return "Lane split count cannot exceed upstream lane count.";
  }

  return null;
}

export function mergeRuntimeValues(values: readonly RuntimeValue[]) {
  const [firstValue] = values;
  if (!firstValue) {
    return null;
  }

  if (!values.every((value) => value.type === firstValue.type)) {
    throw new Error("Lane Merge inputs must have the same lane type.");
  }

  switch (firstValue.type) {
    case "text":
      return {
        type: firstValue.type,
        lanes: values.flatMap((value) =>
          value.type === "text" ? value.lanes : [],
        ),
      } satisfies RuntimeValue;
    case "image":
    case "video":
      return {
        type: firstValue.type,
        lanes: values.flatMap((value) =>
          value.type === firstValue.type ? value.lanes : [],
        ),
      } satisfies RuntimeValue;
  }
}

function getExactAlignedLaneCount(counts: readonly number[]) {
  const laneCounts = counts.filter((count) => count > 0);
  if (!laneCounts.length) {
    return 1;
  }

  const [laneCount] = laneCounts;
  if (
    laneCount === undefined ||
    laneCounts.some((count) => count !== laneCount)
  ) {
    throw new Error("Lane Zip inputs must have matching lane counts.");
  }

  return laneCount;
}

export function zipAlignRuntimeValues(
  values: readonly RuntimeValue[],
  options: { broadcast: boolean },
) {
  const [firstValue] = values;
  if (!firstValue) {
    return null;
  }

  if (!values.every((value) => value.type === firstValue.type)) {
    throw new Error("Lane Zip inputs must have the same lane type.");
  }

  const laneCounts = values.map((value) => value.lanes.length);
  const laneCount = options.broadcast
    ? getAlignedLaneCount(laneCounts)
    : getExactAlignedLaneCount(laneCounts);

  switch (firstValue.type) {
    case "text":
      return {
        type: firstValue.type,
        lanes: Array.from({ length: laneCount }, (_, index) =>
          values
            .flatMap((value) =>
              value.type === "text"
                ? [getBroadcastLane(value.lanes, index)]
                : [],
            )
            .filter((value): value is string => Boolean(value?.trim()))
            .join("\n\n"),
        ).filter(Boolean),
      } satisfies RuntimeValue;
    case "image":
    case "video":
      return {
        type: firstValue.type,
        lanes: Array.from({ length: laneCount }, (_, index) =>
          values.flatMap((value) =>
            value.type === firstValue.type
              ? (getBroadcastLane(value.lanes, index) ?? [])
              : [],
          ),
        ),
      } satisfies RuntimeValue;
  }
}

export function isWorkflowValueType(
  value: unknown,
): value is WorkflowValueType {
  return value === "text" || value === "image" || value === "video";
}
