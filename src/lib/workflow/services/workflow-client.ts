"use client";

import type { Unsubscribable } from "@trpc/server/observable";
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
