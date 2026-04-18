"use client";

import { Effect } from "effect";
import { getErrorMessage, WorkflowRequestError } from "~/lib/workflow/errors";
import type {
  GenerateImageRequest,
  GenerateImageResponse,
  GenerateVideoRequest,
  GenerateVideoResponse,
  UploadAssetResponse,
} from "~/lib/workflow/types";
import { getTrpcClient } from "~/trpc/react";

const trpcClient = getTrpcClient();

export const generateImageRequest = (input: GenerateImageRequest) =>
  Effect.tryPromise({
    try: () => trpcClient.workflow.generateImage.mutate(input),
    catch: (cause) =>
      new WorkflowRequestError({
        message: getErrorMessage(cause),
        cause,
      }),
  }) as Effect.Effect<GenerateImageResponse, WorkflowRequestError>;

export const generateVideoRequest = (input: GenerateVideoRequest) =>
  Effect.tryPromise({
    try: () => trpcClient.workflow.generateVideo.mutate(input),
    catch: (cause) =>
      new WorkflowRequestError({
        message: getErrorMessage(cause),
        cause,
      }),
  }) as Effect.Effect<GenerateVideoResponse, WorkflowRequestError>;

export const uploadAssetRequest = (file: File) =>
  Effect.tryPromise({
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
