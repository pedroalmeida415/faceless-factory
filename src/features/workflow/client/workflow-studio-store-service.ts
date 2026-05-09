"use client";

import { Context, Effect, Layer } from "effect";

import { useWorkflowStudioStore } from "~/components/workflow/studio/store";
import type { TaskStudioProjectionSlot } from "~/features/runtime/task-studio-projection";
import type { WorkflowDocumentNode } from "~/features/workflow/document";
import type { WorkflowStudioSnapshot } from "~/features/workflow/studio-state";
import type { WorkflowNodeStatus } from "~/features/workflow/types";

type WorkflowStudioStoreSnapshot = WorkflowStudioSnapshot & {
  documentRevision: number | null;
  projectId: string | null;
};

export class WorkflowStudioStoreService extends Context.Tag(
  "WorkflowStudioStoreService",
)<
  WorkflowStudioStoreService,
  {
    readonly applyRuntimeTaskProjection: (
      slots: readonly TaskStudioProjectionSlot[],
    ) => Effect.Effect<void>;
    readonly clearExecutionStreaming: () => Effect.Effect<void>;
    readonly getWorkflowSnapshot: () => Effect.Effect<WorkflowStudioStoreSnapshot>;
    readonly setActivity: (activity: string) => Effect.Effect<void>;
    readonly setExecutionStreaming: (
      isStreaming: boolean,
    ) => Effect.Effect<void>;
    readonly setNodeRuntimeState: (
      nodeId: string,
      status: WorkflowNodeStatus,
      error: string | null,
    ) => Effect.Effect<void>;
    readonly updateDocumentNode: (
      nodeId: string,
      updater: (node: WorkflowDocumentNode) => WorkflowDocumentNode,
    ) => Effect.Effect<void>;
  }
>() {
  static readonly Live = Layer.succeed(this, {
    applyRuntimeTaskProjection: (slots) =>
      Effect.sync(() => {
        useWorkflowStudioStore.getState().applyRuntimeTaskProjection(slots);
      }),
    clearExecutionStreaming: () =>
      Effect.sync(() => {
        useWorkflowStudioStore.getState().clearExecutionStreaming();
      }),
    getWorkflowSnapshot: () =>
      Effect.sync(() => {
        const { document, documentRevision, editor, projectId, runtime } =
          useWorkflowStudioStore.getState();
        return { document, documentRevision, editor, projectId, runtime };
      }),
    setActivity: (activity) =>
      Effect.sync(() => {
        useWorkflowStudioStore.getState().setActivity(activity);
      }),
    setExecutionStreaming: (isStreaming) =>
      Effect.sync(() => {
        useWorkflowStudioStore.getState().setExecutionStreaming(isStreaming);
      }),
    setNodeRuntimeState: (nodeId, status, error) =>
      Effect.sync(() => {
        useWorkflowStudioStore
          .getState()
          .setNodeRuntimeState(nodeId, status, error);
      }),
    updateDocumentNode: (nodeId, updater) =>
      Effect.sync(() => {
        useWorkflowStudioStore.getState().updateDocumentNode(nodeId, updater);
      }),
  });
}
