import { Effect } from "effect";
import type { RuntimeValue } from "~/components/workflow/studio/graph";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import type {
  GenerateImageRequest,
  GenerateVideoRequest,
  ImageGeneratorNodeData,
  VideoGeneratorNodeData,
  WorkflowNodeData,
} from "~/lib/workflow/types";
import { coerceImageBatches, coerceTextInput } from "./node-inputs";
import { generateImageRequest, generateVideoRequest } from "./requests";
import {
  type EvaluateNode,
  formatRunningActivity,
  type IncomingByTarget,
} from "./shared";
import { setNodeStatus } from "./state-effects";
import { WorkflowStudioStoreService } from "./store-service";

const executePromptNode = (data: WorkflowNodeData) => {
  if (data.kind !== "prompt") {
    return Effect.die("Invalid prompt node");
  }

  if (!data.prompt.trim()) {
    return Effect.fail(
      new WorkflowValidationError({
        message: "Prompt node is empty.",
      }),
    );
  }

  return Effect.succeed({
    type: "text",
    text: data.prompt,
  } satisfies RuntimeValue);
};

const executeImageNode = (data: WorkflowNodeData) => {
  if (data.kind !== "image") {
    return Effect.die("Invalid image node");
  }

  if (!data.asset) {
    return Effect.fail(
      new WorkflowValidationError({
        message: "Image node has no uploaded asset.",
      }),
    );
  }

  return Effect.succeed({
    type: "image",
    assets: [data.asset],
    iterationMode: "static",
  } satisfies RuntimeValue);
};

const executeVideoNode = (data: WorkflowNodeData) => {
  if (data.kind !== "video") {
    return Effect.die("Invalid video node");
  }

  if (!data.asset) {
    return Effect.fail(
      new WorkflowValidationError({
        message: "Video node has no uploaded asset.",
      }),
    );
  }

  return Effect.succeed({
    type: "video",
    assets: [data.asset],
  } satisfies RuntimeValue);
};

const executeImageIteratorNode = (data: WorkflowNodeData) => {
  if (data.kind !== "imageIterator") {
    return Effect.die("Invalid image iterator node");
  }

  if (!data.assets.length) {
    return Effect.fail(
      new WorkflowValidationError({
        message: "Image iterator is empty.",
      }),
    );
  }

  return Effect.succeed({
    type: "image",
    assets: data.assets,
    iterationMode: "iterator",
  } satisfies RuntimeValue);
};

const executeImageGeneratorNode = (
  currentId: string,
  data: ImageGeneratorNodeData,
  nextPath: ReadonlySet<string>,
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode,
) =>
  Effect.gen(function* () {
    const workflowStudioStore = yield* WorkflowStudioStoreService;

    yield* setNodeStatus(currentId, "running", null);

    const prompt = yield* coerceTextInput(
      nextPath,
      currentId,
      incomingByTarget,
      evaluateNode,
    );
    const batchPlan = yield* coerceImageBatches(
      nextPath,
      currentId,
      incomingByTarget,
      evaluateNode,
    );

    yield* workflowStudioStore.setActivity(
      formatRunningActivity(
        data.label,
        batchPlan.iterations,
        batchPlan.hasIterator,
      ),
    );

    const responses = yield* Effect.forEach(
      batchPlan.batches,
      (referenceImages) =>
        generateImageRequest({
          prompt,
          referenceImages,
          aspectRatio: data.aspectRatio,
        } satisfies GenerateImageRequest),
      { concurrency: "unbounded" },
    );

    const generatedAssets = responses.flatMap((payload) => payload.assets);
    const responseTextParts = responses
      .map((payload) => payload.responseText?.trim())
      .filter((value): value is string => Boolean(value));
    const responseText = responseTextParts.length
      ? Array.from(new Set(responseTextParts)).join("\n\n")
      : null;

    yield* workflowStudioStore.updateNodeData(currentId, (current) => ({
      ...(current as ImageGeneratorNodeData),
      status: "success",
      error: null,
      lastPrompt: prompt,
      responseText,
      outputAssets: generatedAssets,
    }));

    return {
      type: "image",
      assets: generatedAssets,
      iterationMode: "static",
    } satisfies RuntimeValue;
  });

const executeVideoGeneratorNode = (
  currentId: string,
  data: VideoGeneratorNodeData,
  nextPath: ReadonlySet<string>,
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode,
) =>
  Effect.gen(function* () {
    const workflowStudioStore = yield* WorkflowStudioStoreService;

    yield* setNodeStatus(currentId, "running", null);

    const prompt = yield* coerceTextInput(
      nextPath,
      currentId,
      incomingByTarget,
      evaluateNode,
    );
    const batchPlan = yield* coerceImageBatches(
      nextPath,
      currentId,
      incomingByTarget,
      evaluateNode,
    );

    yield* workflowStudioStore.setActivity(
      formatRunningActivity(
        data.label,
        batchPlan.iterations,
        batchPlan.hasIterator,
      ),
    );

    const responses = yield* Effect.forEach(
      batchPlan.batches,
      (referenceImages) =>
        generateVideoRequest({
          prompt,
          referenceImages,
          aspectRatio: data.aspectRatio,
          durationSeconds: data.durationSeconds,
          generateAudio: data.generateAudio,
          resolution: data.resolution,
        } satisfies GenerateVideoRequest),
      { concurrency: "unbounded" },
    );

    const generatedAssets = responses.flatMap((payload) => payload.assets);

    yield* workflowStudioStore.updateNodeData(currentId, (current) => ({
      ...(current as VideoGeneratorNodeData),
      status: "success",
      error: null,
      lastPrompt: prompt,
      responseText: null,
      outputAssets: generatedAssets,
    }));

    return {
      type: "video",
      assets: generatedAssets,
    } satisfies RuntimeValue;
  });

export const executeNode = (
  currentId: string,
  data: WorkflowNodeData,
  nextPath: ReadonlySet<string>,
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode,
) => {
  switch (data.kind) {
    case "prompt":
      return executePromptNode(data);
    case "image":
      return executeImageNode(data);
    case "video":
      return executeVideoNode(data);
    case "imageIterator":
      return executeImageIteratorNode(data);
    case "imageGenerator":
      return executeImageGeneratorNode(
        currentId,
        data,
        nextPath,
        incomingByTarget,
        evaluateNode,
      );
    case "videoGenerator":
      return executeVideoGeneratorNode(
        currentId,
        data,
        nextPath,
        incomingByTarget,
        evaluateNode,
      );
  }
};
