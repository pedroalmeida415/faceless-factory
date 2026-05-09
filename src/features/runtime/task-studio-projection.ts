import {
  isActiveTaskStatus,
  isFailedTaskStatus,
  isTaskDependencySatisfiedStatus,
  type TaskStatus,
} from "~/features/runtime/domain/task-state";
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

export type TaskStudioProjectionSlot = {
  readonly failureReason?: string;
  readonly branchIndex: number;
  readonly nodeRunId: string;
  readonly nodeId: string;
  readonly output?: RenderableTaskOutput;
  readonly status: TaskStatus;
  readonly taskId: string;
};

export function applyTaskStudioProjection(input: {
  readonly document: WorkflowDocument;
  readonly runtime: RuntimeState;
  readonly slots: readonly TaskStudioProjectionSlot[];
}): {
  readonly activeNodeIds: readonly string[];
  readonly document: WorkflowDocument;
  readonly runtime: RuntimeState;
} {
  const slotsByNodeId = groupByNodeId(input.slots);
  const activeNodeIds = Array.from(slotsByNodeId)
    .filter(([, slots]) =>
      slots.some((slot) => isActiveTaskStatus(slot.status)),
    )
    .map(([nodeId]) => nodeId);

  return {
    activeNodeIds,
    document: {
      ...input.document,
      nodes: input.document.nodes.map((node) =>
        projectNodeTasks(node, slotsByNodeId.get(node.id) ?? []),
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

export function hasActiveTaskProjection(
  slots: readonly TaskStudioProjectionSlot[],
) {
  return slots.some((slot) => isActiveTaskStatus(slot.status));
}

function projectNodeTasks(
  node: WorkflowDocumentNode,
  slots: readonly TaskStudioProjectionSlot[],
): WorkflowDocumentNode {
  if (!slots.length) {
    return node;
  }

  if (node.kind === "imageGenerator" || node.kind === "videoGenerator") {
    const outputKind = node.kind === "imageGenerator" ? "image" : "video";
    const outputs = node.outputs.map((output) => output ?? []);
    for (const slot of slots) {
      if (!isTaskDependencySatisfiedStatus(slot.status) || !slot.output) {
        continue;
      }

      const asset = projectRenderableAsset(slot.output, outputKind);
      if (asset) {
        while (outputs.length <= slot.branchIndex) {
          outputs.push([]);
        }
        outputs[slot.branchIndex] = [asset];
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
        isTaskDependencySatisfiedStatus(slot.status) &&
        slot.output?.kind === "inline-text-asset"
      ) {
        outputs[slot.branchIndex] = slot.output.text;
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
  slots: readonly TaskStudioProjectionSlot[],
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
        executionId: null,
        outputIndex: slot.branchIndex,
        status,
        taskId: slot.taskId,
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
  status: TaskStatus,
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
  if (isActiveTaskStatus(status)) {
    return "regenerating";
  }
  return null;
}

function projectNodeRuntimeState(
  slots: readonly TaskStudioProjectionSlot[],
): WorkflowNodeRuntimeState {
  return {
    error:
      slots.find((slot) => isFailedTaskStatus(slot.status))?.failureReason ??
      null,
    status: projectNodeStatus(slots),
  };
}

function projectNodeStatus(
  slots: readonly TaskStudioProjectionSlot[],
): WorkflowNodeStatus {
  if (slots.some((slot) => isFailedTaskStatus(slot.status))) {
    return "error";
  }
  if (
    slots.some((slot) => slot.status === "QUEUED" || slot.status === "RUNNING")
  ) {
    return "running";
  }
  if (slots.some((slot) => isActiveTaskStatus(slot.status))) {
    return "waiting";
  }
  if (slots.some((slot) => slot.status === "APPROVED")) {
    return "success";
  }
  return "idle";
}

function groupByNodeId(slots: readonly TaskStudioProjectionSlot[]) {
  const grouped = new Map<string, TaskStudioProjectionSlot[]>();
  for (const slot of slots) {
    grouped.set(slot.nodeId, [...(grouped.get(slot.nodeId) ?? []), slot]);
  }
  return grouped;
}
