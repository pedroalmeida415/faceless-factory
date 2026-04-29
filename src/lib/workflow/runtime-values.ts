import type { WorkflowValueType } from "~/lib/workflow/node-definitions";
import type { OutputReorderMode, WorkflowAsset } from "~/lib/workflow/types";

export type TextRuntimeValue = {
  type: "text";
  items: string[];
};

export type MediaRuntimeValue = {
  type: "image" | "video";
  items: WorkflowAsset[][];
};

export type RuntimeValue = TextRuntimeValue | MediaRuntimeValue;

export type OutputPermutation = number[];

export function getRuntimeValueOutputCount(value: RuntimeValue) {
  return value.items.length;
}

export function getAlignedOutputCount(counts: readonly number[]) {
  const outputCounts = counts.filter((count) => count > 0);
  if (!outputCounts.length) {
    return 1;
  }

  const outputCount = Math.max(...outputCounts);
  const mismatchedCount = outputCounts.find(
    (count) => count !== 1 && count !== outputCount,
  );

  if (mismatchedCount !== undefined) {
    throw new Error("Connected input output item counts do not match.");
  }

  return outputCount;
}

export function getBroadcastOutput<T>(items: readonly T[], index: number) {
  return items.length === 1 ? items[0] : items[index];
}

export function createIdentityOutputPermutation(outputCount: number) {
  return Array.from({ length: outputCount }, (_, index) => index);
}

function normalizeShift(shift: number, outputCount: number) {
  if (outputCount <= 0) {
    return 0;
  }

  return ((shift % outputCount) + outputCount) % outputCount;
}

export function createShiftedOutputPermutation(
  outputCount: number,
  shift: number,
): OutputPermutation {
  const normalizedShift = normalizeShift(shift, outputCount);
  return Array.from(
    { length: outputCount },
    (_, index) => (index + normalizedShift) % outputCount,
  );
}

export function validateOutputPermutation(
  permutation: readonly number[],
  outputCount: number,
): OutputPermutation {
  const message = getOutputPermutationValidationMessage(
    permutation,
    outputCount,
  );
  if (message) {
    throw new Error(message);
  }

  return [...permutation];
}

export function getOutputPermutationValidationMessage(
  permutation: readonly number[],
  outputCount: number,
) {
  if (permutation.length !== outputCount) {
    return "Output order must include every upstream output exactly once.";
  }

  const seen = new Set<number>();
  for (const index of permutation) {
    if (!Number.isInteger(index) || index < 0 || index >= outputCount) {
      return "Output order contains an out-of-range output index.";
    }

    if (seen.has(index)) {
      return "Output order cannot contain duplicate output indices.";
    }

    seen.add(index);
  }

  return null;
}

export function resolveOutputPermutation(params: {
  outputCount: number;
  mode: OutputReorderMode;
  order: readonly number[];
  shift: number;
}) {
  return params.mode === "manual"
    ? validateOutputPermutation(params.order, params.outputCount)
    : createShiftedOutputPermutation(params.outputCount, params.shift);
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
  const order = validateOutputPermutation(permutation, value.items.length);

  switch (value.type) {
    case "text":
      return {
        type: value.type,
        items: reorderArray(value.items, order),
      };
    case "image":
    case "video":
      return {
        type: value.type,
        items: reorderArray(value.items, order),
      };
  }
}

export function getOutputSelectionValidationMessage(
  indices: readonly number[],
  outputCount: number,
) {
  if (!indices.length) {
    return "Output selection must include at least one output.";
  }

  const seen = new Set<number>();
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= outputCount) {
      return "Output selection contains an out-of-range output index.";
    }
    if (seen.has(index)) {
      return "Output selection cannot contain duplicate output indices.";
    }
    seen.add(index);
  }

  return null;
}

export function selectRuntimeValue(
  value: RuntimeValue,
  indices: readonly number[],
): RuntimeValue {
  const message = getOutputSelectionValidationMessage(
    indices,
    value.items.length,
  );
  if (message) {
    throw new Error(message);
  }

  switch (value.type) {
    case "text":
      return { type: value.type, items: reorderArray(value.items, indices) };
    case "image":
    case "video":
      return { type: value.type, items: reorderArray(value.items, indices) };
  }
}

export function splitRuntimeValueOutput(
  value: RuntimeValue,
  index: number,
): RuntimeValue | null {
  switch (value.type) {
    case "text": {
      const output = value.items[index];
      if (output === undefined) {
        return null;
      }
      return { type: value.type, items: [output] };
    }
    case "image":
    case "video": {
      const output = value.items[index];
      if (output === undefined) {
        return null;
      }
      return { type: value.type, items: [output] };
    }
  }
}

export function getOutputSplitValidationMessage(
  splitCount: number,
  outputCount: number,
) {
  if (!Number.isInteger(splitCount) || splitCount < 1) {
    return "Output split count must be at least one.";
  }

  if (splitCount > outputCount) {
    return "Output split count cannot exceed upstream output count.";
  }

  return null;
}

export function mergeRuntimeValues(values: readonly RuntimeValue[]) {
  const [firstValue] = values;
  if (!firstValue) {
    return null;
  }

  if (!values.every((value) => value.type === firstValue.type)) {
    throw new Error("Output Merge inputs must have the same output type.");
  }

  switch (firstValue.type) {
    case "text":
      return {
        type: firstValue.type,
        items: values.flatMap((value) =>
          value.type === "text" ? value.items : [],
        ),
      } satisfies RuntimeValue;
    case "image":
    case "video":
      return {
        type: firstValue.type,
        items: values.flatMap((value) =>
          value.type === firstValue.type ? value.items : [],
        ),
      } satisfies RuntimeValue;
  }
}

function getExactAlignedOutputCount(counts: readonly number[]) {
  const outputCounts = counts.filter((count) => count > 0);
  if (!outputCounts.length) {
    return 1;
  }

  const [outputCount] = outputCounts;
  if (
    outputCount === undefined ||
    outputCounts.some((count) => count !== outputCount)
  ) {
    throw new Error("Output Zip inputs must have matching output counts.");
  }

  return outputCount;
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
    throw new Error("Output Zip inputs must have the same output type.");
  }

  const outputCounts = values.map((value) => value.items.length);
  const outputCount = options.broadcast
    ? getAlignedOutputCount(outputCounts)
    : getExactAlignedOutputCount(outputCounts);

  switch (firstValue.type) {
    case "text":
      return {
        type: firstValue.type,
        items: Array.from({ length: outputCount }, (_, index) =>
          values
            .flatMap((value) =>
              value.type === "text"
                ? [getBroadcastOutput(value.items, index)]
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
        items: Array.from({ length: outputCount }, (_, index) =>
          values.flatMap((value) =>
            value.type === firstValue.type
              ? (getBroadcastOutput(value.items, index) ?? [])
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
