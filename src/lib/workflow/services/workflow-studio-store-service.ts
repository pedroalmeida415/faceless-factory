"use client";

import { Context, Effect, Layer } from "effect";

import { useWorkflowStudioStore } from "~/components/workflow/studio/store";
import type { WorkflowDocumentNode } from "~/lib/workflow/document";
import type { WorkflowStudioSnapshot } from "~/lib/workflow/studio-state";
import type { WorkflowNodeStatus } from "~/lib/workflow/types";

export class WorkflowStudioStoreService extends Context.Tag(
  "WorkflowStudioStoreService",
)<
  WorkflowStudioStoreService,
  {
    readonly getWorkflowSnapshot: () => Effect.Effect<WorkflowStudioSnapshot>;
    readonly setActivity: (activity: string) => Effect.Effect<void>;
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
  static readonly functions = Effect.serviceFunctions(this);

  static readonly Live = Layer.succeed(this, {
    getWorkflowSnapshot: () =>
      Effect.sync(() => {
        const { document, editor, runtime } = useWorkflowStudioStore.getState();
        return { document, editor, runtime };
      }),
    setActivity: (activity) =>
      Effect.sync(() => {
        useWorkflowStudioStore.getState().setActivity(activity);
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
