"use client";

import type { Unsubscribable } from "@trpc/server/observable";
import { Effect } from "effect";

import { getErrorMessage, WorkflowRequestError } from "~/lib/workflow/errors";
import type {
  StartWorkflowExecutionRequest,
  WorkflowExecutionStatusResponse,
} from "~/lib/workflow/execution/types";
import type {
  WorkflowProjectSaveRequest,
  WorkflowProjectSaveResponse,
} from "~/lib/workflow/project";
import type {
  GenerateImageRequest,
  GenerateImageResponse,
  GenerateLlmRequest,
  GenerateLlmResponse,
  GenerateVideoRequest,
  GenerateVideoResponse,
  UploadAssetResponse,
} from "~/lib/workflow/types";
import { getTrpcClient } from "~/trpc/react";

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

  startExecution(input: StartWorkflowExecutionRequest & { projectId: string }) {
    return Effect.tryPromise({
      try: () => trpcClient.workflow.startExecution.mutate(input),
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    }) as Effect.Effect<WorkflowExecutionStatusResponse, WorkflowRequestError>;
  },

  openExecutionEvents(
    runId: string,
    handlers: {
      onExecutionState: (state: WorkflowExecutionStatusResponse) => void;
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

    const subscription = trpcClient.workflow.executionEvents.subscribe(
      { runId },
      {
        onData: handlers.onExecutionState,
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

  generateImage(input: GenerateImageRequest) {
    return Effect.tryPromise({
      try: () => trpcClient.workflow.generateImage.mutate(input),
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    }) as Effect.Effect<GenerateImageResponse, WorkflowRequestError>;
  },

  generateLlm(input: GenerateLlmRequest) {
    return Effect.tryPromise({
      try: () => trpcClient.workflow.generateLlm.mutate(input),
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    }) as Effect.Effect<GenerateLlmResponse, WorkflowRequestError>;
  },

  generateVideo(input: GenerateVideoRequest) {
    return Effect.tryPromise({
      try: () => trpcClient.workflow.generateVideo.mutate(input),
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    }) as Effect.Effect<GenerateVideoResponse, WorkflowRequestError>;
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
