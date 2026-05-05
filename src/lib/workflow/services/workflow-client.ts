"use client";

import type { Unsubscribable } from "@trpc/server/observable";
import { Effect } from "effect";

import { getErrorMessage, WorkflowRequestError } from "~/lib/workflow/errors";
import type {
  WorkflowProjectSaveRequest,
  WorkflowProjectSaveResponse,
} from "~/lib/workflow/project";
import type { UploadAssetResponse } from "~/lib/workflow/types";
import { getTrpcClient, type RouterOutputs } from "~/trpc/react";

export type WorkflowRuntimeTaskProjection =
  RouterOutputs["workflowRuntime"]["taskProjection"];
export type WorkflowRuntimeRunCostPreview =
  RouterOutputs["workflowRuntime"]["runCostPreview"];

const trpcClient = getTrpcClient();

export const WorkflowClientService = {
  saveProject(input: WorkflowProjectSaveRequest) {
    return Effect.tryPromise({
      try: () => trpcClient.workflow.saveProject.mutate(input),
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    }) as Effect.Effect<WorkflowProjectSaveResponse, WorkflowRequestError>;
  },

  runNode(input: { nodeId: string; projectId: string }) {
    return Effect.tryPromise({
      try: () =>
        trpcClient.workflowRuntime.run.mutate({
          projectId: input.projectId,
          target: { nodeId: input.nodeId, type: "node" },
        }),
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    });
  },

  previewRunNode(input: { nodeId: string; projectId: string }) {
    return Effect.tryPromise({
      try: () =>
        trpcClient.workflowRuntime.runCostPreview.query({
          projectId: input.projectId,
          target: { nodeId: input.nodeId, type: "node" },
        }),
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    }) as Effect.Effect<WorkflowRuntimeRunCostPreview, WorkflowRequestError>;
  },

  runTaskSlot(input: {
    itemIndex: number;
    nodeExecutionId: string;
    projectId: string;
  }) {
    return Effect.tryPromise({
      try: () =>
        trpcClient.workflowRuntime.run.mutate({
          projectId: input.projectId,
          target: {
            itemIndex: input.itemIndex,
            nodeExecutionId: input.nodeExecutionId,
            type: "task-slot",
          },
        }),
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    });
  },

  getTaskProjection(projectId: string) {
    return Effect.tryPromise({
      try: () => trpcClient.workflowRuntime.taskProjection.query({ projectId }),
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    }) as Effect.Effect<WorkflowRuntimeTaskProjection, WorkflowRequestError>;
  },

  openTaskEvents(
    projectId: string,
    handlers: {
      onTaskEvent: () => void;
      onError: (error: WorkflowRequestError) => void;
    },
  ) {
    let isClosed = false;
    let hasErrored = false;

    const reportError = (cause: unknown) => {
      if (isClosed || hasErrored) {
        return;
      }

      hasErrored = true;
      handlers.onError(
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
      );
    };

    const subscription = trpcClient.workflowRuntime.taskEvents.subscribe(
      { projectId },
      {
        onData: handlers.onTaskEvent,
        onConnectionStateChange: (state) => {
          if (state.error) {
            reportError(state.error);
          }
        },
        onError: reportError,
      },
    );

    return {
      unsubscribe() {
        isClosed = true;
        subscription.unsubscribe();
      },
    } satisfies Unsubscribable;
  },

  approveTaskRun(input: {
    attempt: number;
    projectId: string;
    taskRunId: string;
  }) {
    return Effect.tryPromise({
      try: () => trpcClient.workflowRuntime.approveTaskRun.mutate(input),
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    });
  },

  rejectTaskRun(input: {
    attempt: number;
    projectId: string;
    taskRunId: string;
  }) {
    return Effect.tryPromise({
      try: () => trpcClient.workflowRuntime.rejectTaskRun.mutate(input),
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    });
  },

  cancelTaskRun(input: {
    attempt: number;
    projectId: string;
    taskRunId: string;
  }) {
    return Effect.tryPromise({
      try: () => trpcClient.workflowRuntime.cancelTaskRun.mutate(input),
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    });
  },

  uploadAsset(file: File, projectId: string) {
    return Effect.tryPromise({
      try: async () => {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("projectId", projectId);

        const response = await fetch("/api/workflow/assets", {
          body: formData,
          method: "POST",
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: unknown;
          } | null;

          throw new WorkflowRequestError({
            message:
              typeof payload?.error === "string"
                ? payload.error
                : "Asset upload failed.",
          });
        }

        return (await response.json()) as UploadAssetResponse;
      },
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    }) as Effect.Effect<UploadAssetResponse, WorkflowRequestError>;
  },
};
