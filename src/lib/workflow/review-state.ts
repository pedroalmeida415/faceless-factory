import type { WorkflowDocumentNode } from "~/lib/workflow/document";
import type { RuntimeValue } from "~/lib/workflow/lanes";
import type { WorkflowAsset, WorkflowReviewLane } from "~/lib/workflow/types";

export type StaleReviewLane = {
  generatorNodeId: string;
  laneIndex: number;
};

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

export function isSameReviewLaneValue(
  value: RuntimeValue,
  laneIndex: number,
  existingLane: WorkflowReviewLane | undefined,
) {
  if (!existingLane) {
    return false;
  }

  switch (value.type) {
    case "text":
      return (
        (value.lanes[laneIndex]?.trim() ?? "") ===
        (existingLane.text?.trim() ?? "")
      );
    case "image":
    case "video": {
      const assets = value.lanes[laneIndex] ?? [];
      return (
        assets.length === existingLane.assets.length &&
        assets.every((asset, index) => {
          const existingAsset = existingLane.assets[index];
          return (
            existingAsset !== undefined &&
            getAssetIdentity(asset) === getAssetIdentity(existingAsset)
          );
        })
      );
    }
  }
}

export function toReviewLane(
  value: RuntimeValue,
  laneIndex: number,
  existingLane?: WorkflowReviewLane,
): WorkflowReviewLane {
  const isSameValue = isSameReviewLaneValue(value, laneIndex, existingLane);
  const existingStatus = existingLane?.status;
  const status =
    isSameValue &&
    (existingStatus === "approved" || existingStatus === "regenerating")
      ? existingStatus
      : "pending";
  const attempt = isSameValue ? (existingLane?.attempt ?? 0) : 0;

  switch (value.type) {
    case "text":
      return {
        assets: [],
        attempt,
        laneIndex,
        status,
        text: value.lanes[laneIndex] ?? null,
      };
    case "image":
    case "video":
      return {
        assets: value.lanes[laneIndex] ?? [],
        attempt,
        laneIndex,
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
      ? node.review.lanes.map((lane) => [lane.laneIndex, lane])
      : [],
  );
  const staleLaneIndices = Array.from(
    new Set([
      ...params.inputValue.lanes.flatMap((_, laneIndex) =>
        isSameReviewLaneValue(
          params.inputValue,
          laneIndex,
          existingByIndex.get(laneIndex),
        )
          ? []
          : [laneIndex],
      ),
      ...node.review.lanes.flatMap((lane) =>
        lane.laneIndex >= params.inputValue.lanes.length
          ? [lane.laneIndex]
          : [],
      ),
    ]),
  );

  return {
    node: {
      ...node,
      review: {
        lanes: params.inputValue.lanes.map((_, laneIndex) =>
          toReviewLane(
            params.inputValue,
            laneIndex,
            existingByIndex.get(laneIndex),
          ),
        ),
        sourceNodeId: node.id,
        updatedAt: params.updatedAt ?? new Date().toISOString(),
        valueType: params.inputValue.type,
      },
    },
    staleLaneIndices,
  };
}

export function createEmptyWorkflowReviewState() {
  return {
    lanes: [],
    sourceNodeId: null,
    updatedAt: null,
    valueType: null,
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
    if (
      node.review.sourceNodeId !== node.id ||
      params.inputValue.type !== node.review.valueType ||
      params.inputValue.lanes.length !== node.review.lanes.length
    ) {
      return null;
    }

    if (
      params.inputValue.lanes.some(
        (_, laneIndex) =>
          !isSameReviewLaneValue(
            params.inputValue,
            laneIndex,
            node.review.lanes.find((lane) => lane.laneIndex === laneIndex),
          ),
      )
    ) {
      return null;
    }
  }

  const lanes = node.review.lanes
    .filter((lane) => lane.status === "approved")
    .sort((left, right) => left.laneIndex - right.laneIndex);
  if (!lanes.length || lanes.length !== node.review.lanes.length) {
    return null;
  }

  switch (node.review.valueType) {
    case "text":
      return {
        type: "text",
        lanes: lanes.map((lane) => lane.text?.trim() ?? ""),
      };
    case "image":
    case "video":
      return {
        type: node.review.valueType,
        lanes: lanes.map((lane) => lane.assets),
      };
  }
}

export function getApprovedReviewLaneRuntimeValue(
  node: ReviewableGeneratorNode,
  laneIndex: number,
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
      !isSameReviewLaneValue(
        params.inputValue,
        laneIndex,
        node.review.lanes.find(
          (candidate) => candidate.laneIndex === laneIndex,
        ),
      )
    ) {
      return null;
    }
  }

  const lane = node.review.lanes.find(
    (candidate) => candidate.laneIndex === laneIndex,
  );
  if (!lane || lane.status !== "approved") {
    return null;
  }

  switch (node.review.valueType) {
    case "text":
      return { type: "text", lanes: [lane.text?.trim() ?? ""] };
    case "image":
    case "video":
      return { type: node.review.valueType, lanes: [lane.assets] };
  }
}

export function isReviewFullyApproved(node: WorkflowDocumentNode | undefined) {
  return (
    node !== undefined &&
    (node.kind === "imageGenerator" ||
      node.kind === "videoGenerator" ||
      node.kind === "llmGenerator") &&
    node.reviewEnabled &&
    node.review.lanes.length > 0 &&
    node.review.lanes.every((lane) => lane.status === "approved")
  );
}
