import { Deferred, Effect } from "effect";

import type {
  WorkflowDocument,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { updateWorkflowDocumentNode } from "~/lib/workflow/document";
import {
  getErrorMessage,
  WorkflowExecutionError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import {
  coerceMediaInputBatches,
  coercePromptInput,
} from "~/lib/workflow/execution/input-coercion";
import {
  buildWorkflowExecutionStatusResponse,
  createWorkflowExecutionRuntimeState,
  syncWorkflowExecutionRuntimeState,
} from "~/lib/workflow/execution/runtime-state";
import { resolveWorkflowExecutionTargets } from "~/lib/workflow/execution/target-resolution";
import type {
  StartWorkflowExecutionRequest,
  WorkflowExecutionPortError,
  WorkflowExecutionPorts,
  WorkflowExecutionRuntimeState,
  WorkflowExecutionStatusResponse,
  WorkflowRunStatus,
} from "~/lib/workflow/execution/types";
import {
  buildImageGenerationRequest,
  buildVideoGenerationRequest,
} from "~/lib/workflow/generator-models";
import { buildIncomingByTarget, type RuntimeValue } from "~/lib/workflow/graph";
import {
  ImageGeneratorService,
  VideoGeneratorService,
} from "~/lib/workflow/services/node-services";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";

type ExecutionError = WorkflowExecutionError | WorkflowExecutionPortError;
type PendingMap = Map<string, Deferred.Deferred<RuntimeValue, ExecutionError>>;
type NodeMap = Map<string, WorkflowDocumentNode>;

type ExecutionState = {
  document: WorkflowDocument;
  runtime: WorkflowExecutionRuntimeState;
  status: WorkflowRunStatus;
};

type EvaluateNode = (
  currentId: string,
  path: ReadonlySet<string>,
) => Effect.Effect<RuntimeValue, ExecutionError>;

function formatRunningActivity(
  label: string,
  iterations: number,
  hasIterator: boolean,
) {
  return hasIterator
    ? `Running ${label} (${iterations} iterations)...`
    : `Running ${label}...`;
}

function cloneExecutionResponse(
  response: WorkflowExecutionStatusResponse,
): WorkflowExecutionStatusResponse {
  return JSON.parse(
    JSON.stringify(response),
  ) as WorkflowExecutionStatusResponse;
}

export function executeWorkflow(params: {
  request: StartWorkflowExecutionRequest;
  runId: string;
  ports: WorkflowExecutionPorts;
}) {
  const state: ExecutionState = {
    document: params.request.document,
    runtime: createWorkflowExecutionRuntimeState(
      params.request.document,
      "Queued workflow run.",
    ),
    status: "queued",
  };

  const publish = () => {
    const response = buildWorkflowExecutionStatusResponse({
      runId: params.runId,
      document: state.document,
      runtime: syncWorkflowExecutionRuntimeState(state.document, state.runtime),
      status: state.status,
    });

    return params.ports.onStateChange
      ? params.ports.onStateChange(cloneExecutionResponse(response))
      : Effect.void;
  };

  const setStatus = (status: WorkflowRunStatus) => {
    state.status = status;
    return publish();
  };

  const setActivity = (activity: string) => {
    state.runtime = {
      ...state.runtime,
      activity,
    };
    return publish();
  };

  const setNodeRuntime = (
    nodeId: string,
    status: "idle" | "running" | "success" | "error",
    error: string | null,
  ) => {
    state.runtime = {
      ...state.runtime,
      nodeStateById: {
        ...state.runtime.nodeStateById,
        [nodeId]: {
          error,
          status,
        },
      },
    };

    return publish();
  };

  const updateDocumentNode = (
    nodeId: string,
    updater: (node: WorkflowDocumentNode) => WorkflowDocumentNode,
  ) => {
    state.document = updateWorkflowDocumentNode(
      state.document,
      nodeId,
      updater,
    );
    state.runtime = syncWorkflowExecutionRuntimeState(
      state.document,
      state.runtime,
    );
    return publish();
  };

  const executeNode = (
    currentId: string,
    node: WorkflowDocumentNode,
    nextPath: ReadonlySet<string>,
    incomingByTarget: ReturnType<typeof buildIncomingByTarget>,
    evaluateNode: EvaluateNode,
  ): Effect.Effect<RuntimeValue, ExecutionError> => {
    switch (node.kind) {
      case "prompt":
        return Effect.gen(function* () {
          if (!node.prompt.trim()) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Prompt node is empty.",
              }),
            );
          }

          yield* setNodeRuntime(currentId, "success", null);
          return {
            type: "text",
            text: node.prompt.trim(),
          } satisfies RuntimeValue;
        });
      case "asset":
        return Effect.gen(function* () {
          if (!node.assetKind || !node.assets.length) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Asset node is empty.",
              }),
            );
          }

          yield* setNodeRuntime(currentId, "success", null);
          return {
            type: node.assetKind,
            assets: node.assets,
            iterationMode: node.assets.length > 1 ? "iterator" : "static",
          } satisfies RuntimeValue;
        });
      case "imageGenerator":
        return Effect.gen(function* () {
          yield* setNodeRuntime(currentId, "running", null);

          const prompt = yield* coercePromptInput(
            state.document,
            nextPath,
            currentId,
            incomingByTarget,
            evaluateNode,
          );
          const batchPlan = yield* coerceMediaInputBatches(
            state.document,
            nextPath,
            currentId,
            "image",
            incomingByTarget,
            evaluateNode,
          );

          yield* setActivity(
            formatRunningActivity(
              node.label,
              batchPlan.iterations,
              batchPlan.hasIterator,
            ),
          );

          const responses = yield* Effect.forEach(
            batchPlan.batches,
            (imageInputsByHandle) =>
              params.ports.generateImage(
                buildImageGenerationRequest({
                  settings: node,
                  imageInputsByHandle,
                  prompt,
                }),
              ),
            { concurrency: "unbounded" },
          );

          const outputAssets = responses.flatMap((response) => response.assets);
          const responseTextParts = responses
            .map((response) => response.responseText?.trim())
            .filter((value): value is string => Boolean(value));
          const responseText = responseTextParts.length
            ? Array.from(new Set(responseTextParts)).join("\n\n")
            : null;

          yield* updateDocumentNode(currentId, (currentNode) =>
            currentNode.kind === "imageGenerator"
              ? ImageGeneratorService.setExecutionResult(currentNode, {
                  lastPrompt: prompt,
                  responseText,
                  outputAssets,
                })
              : currentNode,
          );
          yield* setNodeRuntime(currentId, "success", null);

          return {
            type: "image",
            assets: outputAssets,
            iterationMode: "static",
          } satisfies RuntimeValue;
        });
      case "videoGenerator":
        return Effect.gen(function* () {
          yield* setNodeRuntime(currentId, "running", null);

          const prompt = yield* coercePromptInput(
            state.document,
            nextPath,
            currentId,
            incomingByTarget,
            evaluateNode,
          );
          const batchPlan = yield* coerceMediaInputBatches(
            state.document,
            nextPath,
            currentId,
            "image",
            incomingByTarget,
            evaluateNode,
          );

          yield* setActivity(
            formatRunningActivity(
              node.label,
              batchPlan.iterations,
              batchPlan.hasIterator,
            ),
          );

          const responses = yield* Effect.forEach(
            batchPlan.batches,
            (imageInputsByHandle) =>
              params.ports.generateVideo(
                buildVideoGenerationRequest({
                  settings: node,
                  imageInputsByHandle,
                  prompt,
                }),
              ),
            { concurrency: "unbounded" },
          );

          const outputAssets = responses.flatMap((response) => response.assets);

          yield* updateDocumentNode(currentId, (currentNode) =>
            currentNode.kind === "videoGenerator"
              ? VideoGeneratorService.setExecutionResult(currentNode, {
                  lastPrompt: prompt,
                  responseText: null,
                  outputAssets,
                })
              : currentNode,
          );
          yield* setNodeRuntime(currentId, "success", null);

          return {
            type: "video",
            assets: outputAssets,
            iterationMode: "static",
          } satisfies RuntimeValue;
        });
    }
  };

  const evaluateNode = (
    currentId: string,
    path: ReadonlySet<string>,
    nodeMap: NodeMap,
    incomingByTarget: ReturnType<typeof buildIncomingByTarget>,
    pending: PendingMap,
  ): Effect.Effect<RuntimeValue, ExecutionError> =>
    Effect.suspend(() => {
      if (path.has(currentId)) {
        return Effect.fail(
          new WorkflowExecutionError({
            message: "Cycle detected in workflow graph.",
          }),
        );
      }

      const cached = pending.get(currentId);
      if (cached) {
        return Deferred.await(cached);
      }

      const recursiveEvaluateNode: EvaluateNode = (nextId, nextPath) =>
        evaluateNode(nextId, nextPath, nodeMap, incomingByTarget, pending);

      return Effect.gen(function* () {
        const deferred = yield* Deferred.make<RuntimeValue, ExecutionError>();
        pending.set(currentId, deferred);

        const nextPath = new Set(path);
        nextPath.add(currentId);

        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const node = nodeMap.get(currentId);
            if (!node) {
              return yield* Effect.fail(
                new WorkflowExecutionError({
                  message: `Node ${currentId} not found.`,
                }),
              );
            }

            return yield* executeNode(
              currentId,
              node,
              nextPath,
              incomingByTarget,
              recursiveEvaluateNode,
            );
          }).pipe(
            Effect.tapError((error) =>
              setNodeRuntime(currentId, "error", getErrorMessage(error)),
            ),
          ),
        );

        yield* Deferred.done(deferred, exit);
        return yield* Deferred.await(deferred);
      });
    });

  return Effect.gen(function* () {
    yield* publish();

    const targetIds = resolveWorkflowExecutionTargets(
      state.document,
      params.request.selection?.nodeIds ?? [],
      params.request.target,
    );

    if (!targetIds.length) {
      return yield* Effect.fail(
        new WorkflowValidationError({
          message: "Add an image or video generator first.",
        }),
      );
    }

    WorkflowGraphValidator.validateExecutionTargets(state.document, targetIds);

    state.status = "running";
    state.runtime = {
      ...state.runtime,
      activity: "Running workflow...",
      startedAt: new Date().toISOString(),
    };
    yield* publish();

    const nodeMap: NodeMap = new Map(
      state.document.nodes.map((node) => [node.id, node]),
    );
    const incomingByTarget = buildIncomingByTarget(state.document.edges);
    const pending: PendingMap = new Map();

    yield* Effect.forEach(
      targetIds,
      (nodeId) =>
        evaluateNode(nodeId, new Set(), nodeMap, incomingByTarget, pending),
      {
        concurrency: 1,
        discard: true,
      },
    );

    state.runtime = {
      ...state.runtime,
      activity: "Workflow run finished.",
      error: null,
      finishedAt: new Date().toISOString(),
    };
    yield* setStatus("success");

    return buildWorkflowExecutionStatusResponse({
      runId: params.runId,
      document: state.document,
      runtime: syncWorkflowExecutionRuntimeState(state.document, state.runtime),
      status: state.status,
    });
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        state.runtime = {
          ...state.runtime,
          activity: getErrorMessage(error),
          error: getErrorMessage(error),
          finishedAt: state.runtime.finishedAt ?? new Date().toISOString(),
        };
        yield* setStatus("error");
        return yield* Effect.fail(error);
      }),
    ),
  );
}
