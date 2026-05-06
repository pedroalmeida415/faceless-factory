import {
  isActiveTaskRunStatus,
  isFailedTaskRunStatus,
  isTaskRunDependencySatisfiedStatus,
  type TaskRunStatus,
} from "~/features/runtime/domain/task-run-state";
import type { RenderableTaskOutput } from "~/features/runtime/events/task-status-events";
import type {
  WorkflowDocument,
  WorkflowDocumentNode,
} from "~/features/workflow/document";
import type {
  RuntimeState,
  WorkflowNodeRuntimeState,
} from "~/features/workflow/studio-state";
import type {
  WorkflowAsset,
  WorkflowNodeStatus,
  WorkflowReviewOutput,
  WorkflowReviewState,
} from "~/features/workflow/types";

export type TaskRunStudioProjectionSlot = {
  readonly attempt: number;
  readonly failureReason?: string;
  readonly itemIndex: number;
  readonly nodeExecutionId: string;
  readonly nodeId: string;
  readonly output?: RenderableTaskOutput;
  readonly status: TaskRunStatus;
  readonly taskRunId: string;
};

export function applyTaskRunStudioProjection(input: {
  readonly document: WorkflowDocument;
  readonly runtime: RuntimeState;
  readonly slots: readonly TaskRunStudioProjectionSlot[];
}): {
  readonly activeNodeIds: readonly string[];
  readonly document: WorkflowDocument;
  readonly runtime: RuntimeState;
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
    const outputs = node.outputs.map((output) => output ?? []);
    for (const slot of slots) {
      if (!isTaskRunDependencySatisfiedStatus(slot.status) || !slot.output) {
        continue;
      }

      const asset = projectRenderableAsset(slot.output, outputKind);
      if (asset) {
        while (outputs.length <= slot.itemIndex) {
          outputs.push([]);
        }
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
        isTaskRunDependencySatisfiedStatus(slot.status) &&
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
  status: TaskRunStatus,
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
  if (isActiveTaskRunStatus(status)) {
    return "regenerating";
  }
  return null;
}

function projectNodeRuntimeState(
  slots: readonly TaskRunStudioProjectionSlot[],
): WorkflowNodeRuntimeState {
  return {
    error:
      slots.find((slot) => isFailedTaskRunStatus(slot.status))?.failureReason ??
      null,
    status: projectNodeStatus(slots),
  };
}

function projectNodeStatus(
  slots: readonly TaskRunStudioProjectionSlot[],
): WorkflowNodeStatus {
  if (slots.some((slot) => isFailedTaskRunStatus(slot.status))) {
    return "error";
  }
  if (
    slots.some((slot) => slot.status === "QUEUED" || slot.status === "RUNNING")
  ) {
    return "running";
  }
  if (slots.some((slot) => isActiveTaskRunStatus(slot.status))) {
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
