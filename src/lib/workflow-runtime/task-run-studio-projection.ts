import type {
  WorkflowDocument,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import type {
  WorkflowNodeRuntimeState,
  WorkflowRuntimeState,
} from "~/lib/workflow/studio-state";
import type {
  WorkflowAsset,
  WorkflowNodeStatus,
  WorkflowReviewOutput,
  WorkflowReviewState,
} from "~/lib/workflow/types";
import type { RenderableTaskOutput } from "~/lib/workflow-runtime/runtime/task-status-events";

export type TaskRunStudioProjectionSlot = {
  readonly attempt: number;
  readonly failureReason?: string;
  readonly itemIndex: number;
  readonly nodeExecutionId: string;
  readonly nodeId: string;
  readonly output?: RenderableTaskOutput;
  readonly status:
    | "WAITING_UPSTREAM"
    | "QUEUED"
    | "RUNNING"
    | "PENDING_REVIEW"
    | "APPROVED"
    | "REJECTED"
    | "CANCELLED"
    | "FAILED"
    | "UPSTREAM_FAILED";
  readonly taskRunId: string;
};

export function applyTaskRunStudioProjection(input: {
  readonly document: WorkflowDocument;
  readonly runtime: WorkflowRuntimeState;
  readonly slots: readonly TaskRunStudioProjectionSlot[];
}): {
  readonly activeNodeIds: readonly string[];
  readonly document: WorkflowDocument;
  readonly runtime: WorkflowRuntimeState;
} {
  const slotsByNodeId = groupByNodeId(input.slots);
  const activeNodeIds = Array.from(slotsByNodeId)
    .filter(([, slots]) =>
      slots.some((slot) => isActiveTaskRunStatus(slot.status)),
    )
    .map(([nodeId]) => nodeId);

  return {
    activeNodeIds,
    document: {
      ...input.document,
      nodes: input.document.nodes.map((node) =>
        projectNodeTaskRuns(node, slotsByNodeId.get(node.id) ?? []),
      ),
    },
    runtime: {
      ...input.runtime,
      activity: activeNodeIds.length
        ? "Workflow runtime is running."
        : "Workflow runtime is up to date.",
      nodeStateById: {
        ...input.runtime.nodeStateById,
        ...Object.fromEntries(
          Array.from(slotsByNodeId).map(([nodeId, slots]) => [
            nodeId,
            projectNodeRuntimeState(slots),
          ]),
        ),
      },
    },
  };
}

export function hasActiveTaskRunProjection(
  slots: readonly TaskRunStudioProjectionSlot[],
) {
  return slots.some((slot) => isActiveTaskRunStatus(slot.status));
}

function projectNodeTaskRuns(
  node: WorkflowDocumentNode,
  slots: readonly TaskRunStudioProjectionSlot[],
): WorkflowDocumentNode {
  if (!slots.length) {
    return node;
  }

  if (node.kind === "imageGenerator" || node.kind === "videoGenerator") {
    const outputKind = node.kind === "imageGenerator" ? "image" : "video";
    const outputs = [...node.outputs];
    for (const slot of slots) {
      if (slot.status !== "APPROVED" || !slot.output) {
        continue;
      }

      const asset = projectRenderableAsset(slot.output, outputKind);
      if (asset) {
        outputs[slot.itemIndex] = [asset];
      }
    }

    return {
      ...node,
      outputs,
      review: projectReviewState(node.review, slots, outputKind),
    };
  }

  if (node.kind === "llmGenerator") {
    const outputs = [...node.outputs];
    for (const slot of slots) {
      if (
        slot.status === "APPROVED" &&
        slot.output?.kind === "inline-text-asset"
      ) {
        outputs[slot.itemIndex] = slot.output.text;
      }
    }

    return {
      ...node,
      outputs,
      review: projectReviewState(node.review, slots, "text"),
    };
  }

  return node;
}

function projectReviewState(
  currentReview: WorkflowReviewState,
  slots: readonly TaskRunStudioProjectionSlot[],
  valueType: NonNullable<WorkflowReviewState["valueType"]>,
): WorkflowReviewState {
  const reviewOutputs = slots.flatMap((slot): WorkflowReviewOutput[] => {
    const status = projectReviewStatus(slot.status);
    if (!status) {
      return [];
    }

    const asset =
      valueType === "image" || valueType === "video"
        ? projectRenderableAsset(slot.output, valueType)
        : null;

    return [
      {
        assets: asset ? [asset] : [],
        attempt: slot.attempt,
        executionId: null,
        outputIndex: slot.itemIndex,
        status,
        taskRunId: slot.taskRunId,
        text:
          slot.output?.kind === "inline-text-asset" ? slot.output.text : null,
      },
    ];
  });

  if (!reviewOutputs.length) {
    return currentReview;
  }

  return {
    outputs: reviewOutputs.sort(
      (left, right) => left.outputIndex - right.outputIndex,
    ),
    sourceNodeId: slots[0]?.nodeId ?? currentReview.sourceNodeId,
    updatedAt: new Date().toISOString(),
    valueType,
  };
}

function projectRenderableAsset(
  output: RenderableTaskOutput | undefined,
  kind: "image" | "video",
): WorkflowAsset | null {
  if (output?.kind !== "cdn-asset") {
    return null;
  }

  return {
    createdAt: "",
    externalUri: null,
    fileName: `Generated ${kind}`,
    id: output.assetId,
    kind,
    mimeType: output.contentType,
    model: null,
    size: 0,
    source: "generated",
    storagePath: null,
    url: output.cdnUrl,
  };
}

function projectReviewStatus(
  status: TaskRunStudioProjectionSlot["status"],
): WorkflowReviewOutput["status"] | null {
  if (status === "PENDING_REVIEW") {
    return "pending";
  }
  if (status === "APPROVED") {
    return "approved";
  }
  if (status === "REJECTED") {
    return "rejected";
  }
  if (
    status === "QUEUED" ||
    status === "RUNNING" ||
    status === "WAITING_UPSTREAM"
  ) {
    return "regenerating";
  }
  return null;
}

function projectNodeRuntimeState(
  slots: readonly TaskRunStudioProjectionSlot[],
): WorkflowNodeRuntimeState {
  return {
    error:
      slots.find((slot) => isErrorTaskRunStatus(slot.status))?.failureReason ??
      null,
    status: projectNodeStatus(slots),
  };
}

function projectNodeStatus(
  slots: readonly TaskRunStudioProjectionSlot[],
): WorkflowNodeStatus {
  if (
    slots.some(
      (slot) => slot.status === "FAILED" || slot.status === "UPSTREAM_FAILED",
    )
  ) {
    return "error";
  }
  if (
    slots.some((slot) => slot.status === "QUEUED" || slot.status === "RUNNING")
  ) {
    return "running";
  }
  if (
    slots.some(
      (slot) =>
        slot.status === "WAITING_UPSTREAM" || slot.status === "PENDING_REVIEW",
    )
  ) {
    return "waiting";
  }
  if (slots.some((slot) => slot.status === "APPROVED")) {
    return "success";
  }
  return "idle";
}

function groupByNodeId(slots: readonly TaskRunStudioProjectionSlot[]) {
  const grouped = new Map<string, TaskRunStudioProjectionSlot[]>();
  for (const slot of slots) {
    grouped.set(slot.nodeId, [...(grouped.get(slot.nodeId) ?? []), slot]);
  }
  return grouped;
}

function isActiveTaskRunStatus(status: TaskRunStudioProjectionSlot["status"]) {
  return (
    status === "WAITING_UPSTREAM" ||
    status === "QUEUED" ||
    status === "RUNNING" ||
    status === "PENDING_REVIEW"
  );
}

function isErrorTaskRunStatus(status: TaskRunStudioProjectionSlot["status"]) {
  return status === "FAILED" || status === "UPSTREAM_FAILED";
}
