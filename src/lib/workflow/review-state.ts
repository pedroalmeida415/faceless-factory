import type { WorkflowDocumentNode } from "~/lib/workflow/document";
import type { RuntimeValue } from "~/lib/workflow/runtime-values";
import type { WorkflowAsset, WorkflowReviewOutput } from "~/lib/workflow/types";

type ReviewableGeneratorNode = Extract<
  WorkflowDocumentNode,
  { kind: "imageGenerator" | "videoGenerator" | "llmGenerator" }
>;

function getAssetIdentity(asset: WorkflowAsset) {
  return [
    asset.id,
    asset.storagePath ?? "",
    asset.externalUri ?? "",
    asset.url,
  ].join("::");
}

export function isSameReviewOutputValue(
  value: RuntimeValue,
  outputIndex: number,
  existingOutput: WorkflowReviewOutput | undefined,
) {
  if (!existingOutput) {
    return false;
  }

  switch (value.type) {
    case "text":
      return (
        (value.items[outputIndex]?.trim() ?? "") ===
        (existingOutput.text?.trim() ?? "")
      );
    case "image":
    case "video": {
      const assets = value.items[outputIndex] ?? [];
      return (
        assets.length === existingOutput.assets.length &&
        assets.every((asset, index) => {
          const existingAsset = existingOutput.assets[index];
          return (
            existingAsset !== undefined &&
            getAssetIdentity(asset) === getAssetIdentity(existingAsset)
          );
        })
      );
    }
  }
}

export function toReviewOutput(
  value: RuntimeValue,
  outputIndex: number,
  existingOutput?: WorkflowReviewOutput,
): WorkflowReviewOutput {
  const isSameValue = isSameReviewOutputValue(
    value,
    outputIndex,
    existingOutput,
  );
  const existingStatus = existingOutput?.status;
  const status =
    isSameValue &&
    (existingStatus === "approved" || existingStatus === "regenerating")
      ? existingStatus
      : "pending";
  const attempt = isSameValue ? (existingOutput?.attempt ?? 0) : 0;

  switch (value.type) {
    case "text":
      return {
        assets: [],
        attempt,
        executionId: existingOutput?.executionId ?? null,
        outputIndex,
        status,
        text: value.items[outputIndex] ?? null,
      };
    case "image":
    case "video":
      return {
        assets: value.items[outputIndex] ?? [],
        attempt,
        executionId: existingOutput?.executionId ?? null,
        outputIndex,
        status,
        text: null,
      };
  }
}

export function syncGeneratorReviewForOutput(
  node: ReviewableGeneratorNode,
  params: {
    inputValue: RuntimeValue;
    updatedAt?: string;
  },
) {
  const existingByIndex = new Map(
    node.review.valueType === params.inputValue.type &&
      node.review.sourceNodeId === node.id
      ? node.review.outputs.map((output) => [output.outputIndex, output])
      : [],
  );
  return {
    node: {
      ...node,
      review: {
        outputs: params.inputValue.items.map((_, outputIndex) =>
          toReviewOutput(
            params.inputValue,
            outputIndex,
            existingByIndex.get(outputIndex),
          ),
        ),
        sourceNodeId: node.id,
        updatedAt: params.updatedAt ?? new Date().toISOString(),
        valueType: params.inputValue.type,
      },
    },
  };
}

export function getApprovedReviewRuntimeValue(
  node: ReviewableGeneratorNode,
  params?: {
    inputValue: RuntimeValue;
  },
): RuntimeValue | null {
  if (!node.reviewEnabled || node.review.valueType === null) {
    return null;
  }

  if (params) {
    const outputCount = getReviewOutputCount(node);
    if (
      node.review.sourceNodeId !== node.id ||
      params.inputValue.type !== node.review.valueType ||
      params.inputValue.items.length !== outputCount
    ) {
      return null;
    }

    if (
      params.inputValue.items.some(
        (_, outputIndex) =>
          !isSameReviewOutputValue(
            params.inputValue,
            outputIndex,
            node.review.outputs.find(
              (output) => output.outputIndex === outputIndex,
            ),
          ),
      )
    ) {
      return null;
    }
  }

  const outputs = node.review.outputs
    .filter((output) => output.status === "approved")
    .sort((left, right) => left.outputIndex - right.outputIndex);
  const outputCount = getReviewOutputCount(node);
  if (!outputs.length || outputs.length !== outputCount) {
    return null;
  }

  switch (node.review.valueType) {
    case "text":
      return {
        type: "text",
        items: outputs.map((output) => output.text?.trim() ?? ""),
      };
    case "image":
    case "video":
      return {
        type: node.review.valueType,
        items: outputs.map((output) => output.assets),
      };
  }
}

export function getApprovedReviewOutputRuntimeValue(
  node: ReviewableGeneratorNode,
  outputIndex: number,
  params?: {
    inputValue: RuntimeValue;
  },
): RuntimeValue | null {
  if (!node.reviewEnabled || node.review.valueType === null) {
    return null;
  }

  if (params) {
    if (
      node.review.sourceNodeId !== node.id ||
      params.inputValue.type !== node.review.valueType ||
      !isSameReviewOutputValue(
        params.inputValue,
        outputIndex,
        node.review.outputs.find(
          (candidate) => candidate.outputIndex === outputIndex,
        ),
      )
    ) {
      return null;
    }
  }

  const output = node.review.outputs.find(
    (candidate) => candidate.outputIndex === outputIndex,
  );
  if (!output || output.status !== "approved") {
    return null;
  }

  switch (node.review.valueType) {
    case "text":
      return { type: "text", items: [output.text?.trim() ?? ""] };
    case "image":
    case "video":
      return { type: node.review.valueType, items: [output.assets] };
  }
}

export function getReviewOutputCount(node: ReviewableGeneratorNode) {
  return node.reviewEnabled && node.review.valueType !== null
    ? node.review.outputs.reduce(
        (count, output) => Math.max(count, output.outputIndex + 1),
        0,
      )
    : 0;
}

export function isReviewFullyApproved(node: WorkflowDocumentNode | undefined) {
  if (
    node === undefined ||
    (node.kind !== "imageGenerator" &&
      node.kind !== "videoGenerator" &&
      node.kind !== "llmGenerator") ||
    !node.reviewEnabled
  ) {
    return false;
  }

  const outputCount = getReviewOutputCount(node);
  return (
    outputCount > 0 &&
    node.review.outputs.length === outputCount &&
    node.review.outputs.every((output) => output.status === "approved")
  );
}
