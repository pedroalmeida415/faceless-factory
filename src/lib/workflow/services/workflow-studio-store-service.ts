"use client";

import { Context, Effect, Layer } from "effect";

import { useWorkflowStudioStore } from "~/components/workflow/studio/store";
import type { WorkflowDocumentNode } from "~/lib/workflow/document";
import type { WorkflowExecutionStatusResponse } from "~/lib/workflow/execution/types";
import type { WorkflowStudioSnapshot } from "~/lib/workflow/studio-state";
import type { WorkflowNodeStatus } from "~/lib/workflow/types";

export class WorkflowStudioStoreService extends Context.Tag(
  "WorkflowStudioStoreService",
)<
  WorkflowStudioStoreService,
  {
    readonly applyServerExecutionState: (
      executionState: WorkflowExecutionStatusResponse,
    ) => Effect.Effect<void>;
    readonly clearActiveRunId: () => Effect.Effect<void>;
    readonly getWorkflowSnapshot: () => Effect.Effect<WorkflowStudioSnapshot>;
    readonly setActivity: (activity: string) => Effect.Effect<void>;
    readonly setActiveRunId: (runId: string) => Effect.Effect<void>;
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
  static readonly functions = Effect.serviceFunctions(this);

  static readonly Live = Layer.succeed(this, {
    applyServerExecutionState: (executionState) =>
      Effect.sync(() => {
        useWorkflowStudioStore
          .getState()
          .applyServerExecutionState(executionState);
      }),
    clearActiveRunId: () =>
      Effect.sync(() => {
        useWorkflowStudioStore.getState().clearActiveRunId();
      }),
    getWorkflowSnapshot: () =>
      Effect.sync(() => {
        const { document, editor, runtime } = useWorkflowStudioStore.getState();
        return { document, editor, runtime };
      }),
    setActivity: (activity) =>
      Effect.sync(() => {
        useWorkflowStudioStore.getState().setActivity(activity);
      }),
    setActiveRunId: (runId) =>
      Effect.sync(() => {
        useWorkflowStudioStore.getState().setActiveRunId(runId);
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
