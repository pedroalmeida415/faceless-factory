"use client";

import { Effect } from "effect";

import { getErrorMessage, WorkflowRequestError } from "~/lib/workflow/errors";
import type {
  StartWorkflowExecutionRequest,
  WorkflowExecutionStatusResponse,
} from "~/lib/workflow/execution/types";
import type {
  GenerateImageRequest,
  GenerateImageResponse,
  GenerateVideoRequest,
  GenerateVideoResponse,
  UploadAssetResponse,
} from "~/lib/workflow/types";
import { getTrpcClient } from "~/trpc/react";

const trpcClient = getTrpcClient();

function buildWorkflowExecutionEventsUrl(runId: string) {
  return `/api/workflow-runs/${encodeURIComponent(runId)}/events`;
}

export const WorkflowClientService = {
  startExecution(input: StartWorkflowExecutionRequest) {
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
    const eventSource = new EventSource(buildWorkflowExecutionEventsUrl(runId));

    eventSource.addEventListener("status", (event) => {
      try {
        handlers.onExecutionState(
          JSON.parse(
            (event as MessageEvent<string>).data,
          ) as WorkflowExecutionStatusResponse,
        );
      } catch (cause) {
        handlers.onError(
          new WorkflowRequestError({
            message: getErrorMessage(cause),
            cause,
          }),
        );
      }
    });

    eventSource.addEventListener("error", () => {
      if (eventSource.readyState !== EventSource.CLOSED) {
        return;
      }

      handlers.onError(
        new WorkflowRequestError({
          message: "Workflow event stream closed unexpectedly.",
        }),
      );
    });

    return eventSource;
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

  uploadAsset(file: File) {
    return Effect.tryPromise({
      try: () => {
        const formData = new FormData();
        formData.append("file", file);
        return trpcClient.workflow.uploadAsset.mutate(formData);
      },
      catch: (cause) =>
        new WorkflowRequestError({
          message: getErrorMessage(cause),
          cause,
        }),
    }) as Effect.Effect<UploadAssetResponse, WorkflowRequestError>;
  },
};
