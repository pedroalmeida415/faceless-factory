import { Deferred, Effect } from "effect";

import type {
  PromptWorkflowNode,
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
  coerceTextInputBatch,
} from "~/lib/workflow/execution/input-coercion";
import {
  buildWorkflowExecutionStatusResponse,
  createWorkflowExecutionRuntimeState,
  syncWorkflowExecutionRuntimeState,
} from "~/lib/workflow/execution/runtime-state";
import { buildWorkflowExecutionPlan } from "~/lib/workflow/execution/subgraph";
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
  getImageGeneratorModelCreditCost,
  getVideoGeneratorModelCreditCost,
} from "~/lib/workflow/generator-models";
import {
  buildGeneratorExecutionBatchPlan,
  buildIncomingByTarget,
  buildTextRuntimeValue,
  getIncomingEdgesForHandle,
  getPromptNodeReferencedVariableKeys,
  getWorkflowGeneratorOutputRuntimeValue,
  type RuntimeValue,
  resolvePromptNodeTextBatch,
  type TextRuntimeValue,
} from "~/lib/workflow/graph";
import {
  buildLlmGenerationRequest,
  calculateLlmUsageCreditCost,
  SYSTEM_PROMPT_INPUT_HANDLE_ID,
} from "~/lib/workflow/llm-models";
import { PROMPT_INPUT_HANDLE_ID } from "~/lib/workflow/node-definitions";
import {
  ImageGeneratorService,
  LlmGeneratorService,
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
    ? `Running ${label} (${iterations} lanes)...`
    : `Running ${label}...`;
}

function formatExecutedText(values: ReadonlyArray<string | null>) {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ).join("\n\n");
}

function cloneExecutionResponse(
  response: WorkflowExecutionStatusResponse,
): WorkflowExecutionStatusResponse {
  return JSON.parse(
    JSON.stringify(response),
  ) as WorkflowExecutionStatusResponse;
}

function coerceGeneratorExecutionBatchPlan(
  input: Parameters<typeof buildGeneratorExecutionBatchPlan>[0],
) {
  return Effect.try({
    try: () => buildGeneratorExecutionBatchPlan(input),
    catch: (cause) =>
      new WorkflowValidationError({
        message:
          cause instanceof Error ? cause.message : "Invalid generator batch.",
        cause,
      }),
  });
}

function evaluatePromptNodeTextBatch(
  node: PromptWorkflowNode,
  path: ReadonlySet<string>,
  incomingByTarget: ReturnType<typeof buildIncomingByTarget>,
  evaluateNode: EvaluateNode,
) {
  return Effect.gen(function* () {
    const resolvedVariables = new Map(
      yield* Effect.forEach(
        getPromptNodeReferencedVariableKeys(node),
        (key) =>
          Effect.gen(function* () {
            const values = yield* Effect.forEach(
              getIncomingEdgesForHandle(incomingByTarget, node.id, key),
              (edge) => evaluateNode(edge.source, path),
              {
                concurrency: "unbounded",
              },
            );

            return [
              key,
              buildTextRuntimeValue(
                values.flatMap((value) =>
                  value.type === "text" ? [value] : [],
                ),
              ),
            ] as const;
          }),
        {
          concurrency: "unbounded",
        },
      ),
    );

    return resolvePromptNodeTextBatch(
      node,
      (key) => resolvedVariables.get(key) ?? null,
    );
  });
}

export function executeWorkflow(params: {
  request: StartWorkflowExecutionRequest;
  runId: string;
  ports: WorkflowExecutionPorts;
}) {
  const targetNodeIds = resolveWorkflowExecutionTargets(
    params.request.document,
    params.request.selection?.nodeIds ?? [],
    params.request.target,
  );
  const executionPlan = buildWorkflowExecutionPlan(
    params.request.document,
    targetNodeIds,
  );
  const targetNodeIdSet = new Set(targetNodeIds);
  const executedNodeIds = executionPlan.executableNodeIds;

  const state: ExecutionState = {
    document: params.request.document,
    runtime: createWorkflowExecutionRuntimeState(
      params.request.document,
      "Queued workflow run.",
    ),
    status: "queued",
  };
  let projectDocumentRevision = params.request.documentRevision ?? null;
  let finalCostCredits = 0;

  const publish = () => {
    const response = buildWorkflowExecutionStatusResponse({
      runId: params.runId,
      targetNodeIds: executedNodeIds,
      projectDocumentRevision,
      finalCostCredits: state.status === "success" ? finalCostCredits : null,
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
    const storedOutput = getWorkflowGeneratorOutputRuntimeValue(node);
    if (storedOutput && !targetNodeIdSet.has(currentId)) {
      return Effect.gen(function* () {
        yield* setNodeRuntime(currentId, "success", null);
        return storedOutput;
      });
    }

    switch (node.kind) {
      case "list":
        return Effect.gen(function* () {
          const textValues = node.items
            .map((value) => value.trim())
            .filter(Boolean);
          const textValue = buildTextRuntimeValue([
            {
              type: "text",
              lanes: textValues,
            },
          ]);

          if (!textValue) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "List node is empty.",
              }),
            );
          }

          yield* setNodeRuntime(currentId, "success", null);
          return textValue satisfies RuntimeValue;
        });
      case "prompt":
        return Effect.gen(function* () {
          const textValue = yield* evaluatePromptNodeTextBatch(
            node,
            nextPath,
            incomingByTarget,
            evaluateNode,
          );

          if (!textValue) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Prompt node is empty.",
              }),
            );
          }

          yield* setNodeRuntime(currentId, "success", null);
          return textValue satisfies RuntimeValue;
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
            lanes: node.assets.map((asset) => [asset]),
          } satisfies RuntimeValue;
        });
      case "imageGenerator":
        return Effect.gen(function* () {
          yield* setNodeRuntime(currentId, "running", null);

          const prompt = (yield* coerceTextInputBatch(
            state.document,
            nextPath,
            currentId,
            PROMPT_INPUT_HANDLE_ID,
            {
              message: "Connect prompt text.",
              required: true,
            },
            incomingByTarget,
            evaluateNode,
          )) as TextRuntimeValue;
          const mediaPlan = yield* coerceMediaInputBatches(
            state.document,
            nextPath,
            currentId,
            "image",
            incomingByTarget,
            evaluateNode,
          );
          const batchPlan = yield* coerceGeneratorExecutionBatchPlan({
            mediaPlan,
            prompt,
          });

          yield* setActivity(
            formatRunningActivity(
              node.label,
              batchPlan.iterations,
              batchPlan.hasIterator,
            ),
          );

          const responses = yield* Effect.forEach(
            batchPlan.batches,
            (batch) =>
              params.ports.generateImage(
                buildImageGenerationRequest({
                  settings: node,
                  imageInputsByHandle: batch.mediaInputsByHandle,
                  prompt: batch.prompt,
                }),
              ),
            { concurrency: "unbounded" },
          );

          finalCostCredits +=
            responses.length * getImageGeneratorModelCreditCost(node.model);

          const outputLanes = responses.map((response) => response.assets);
          const outputAssets = outputLanes.flat();
          const responseTextParts = responses
            .map((response) => response.responseText?.trim())
            .filter((value): value is string => Boolean(value));
          const responseText = responseTextParts.length
            ? Array.from(new Set(responseTextParts)).join("\n\n")
            : null;

          yield* updateDocumentNode(currentId, (currentNode) =>
            currentNode.kind === "imageGenerator"
              ? ImageGeneratorService.setExecutionResult(currentNode, {
                  lastPrompt: formatExecutedText(
                    batchPlan.batches.map((batch) => batch.prompt),
                  ),
                  responseText,
                  outputAssets,
                  outputLanes,
                })
              : currentNode,
          );
          yield* setNodeRuntime(currentId, "success", null);

          return {
            type: "image",
            lanes: outputLanes,
          } satisfies RuntimeValue;
        });
      case "videoGenerator":
        return Effect.gen(function* () {
          yield* setNodeRuntime(currentId, "running", null);

          const prompt = (yield* coerceTextInputBatch(
            state.document,
            nextPath,
            currentId,
            PROMPT_INPUT_HANDLE_ID,
            {
              message: "Connect prompt text.",
              required: true,
            },
            incomingByTarget,
            evaluateNode,
          )) as TextRuntimeValue;
          const mediaPlan = yield* coerceMediaInputBatches(
            state.document,
            nextPath,
            currentId,
            "image",
            incomingByTarget,
            evaluateNode,
          );
          const batchPlan = yield* coerceGeneratorExecutionBatchPlan({
            mediaPlan,
            prompt,
          });

          yield* setActivity(
            formatRunningActivity(
              node.label,
              batchPlan.iterations,
              batchPlan.hasIterator,
            ),
          );

          const responses = yield* Effect.forEach(
            batchPlan.batches,
            (batch) =>
              params.ports.generateVideo(
                buildVideoGenerationRequest({
                  settings: node,
                  imageInputsByHandle: batch.mediaInputsByHandle,
                  prompt: batch.prompt,
                }),
              ),
            { concurrency: "unbounded" },
          );

          finalCostCredits +=
            responses.length * getVideoGeneratorModelCreditCost(node.model);

          const outputLanes = responses.map((response) => response.assets);
          const outputAssets = outputLanes.flat();

          yield* updateDocumentNode(currentId, (currentNode) =>
            currentNode.kind === "videoGenerator"
              ? VideoGeneratorService.setExecutionResult(currentNode, {
                  lastPrompt: formatExecutedText(
                    batchPlan.batches.map((batch) => batch.prompt),
                  ),
                  responseText: null,
                  outputAssets,
                  outputLanes,
                })
              : currentNode,
          );
          yield* setNodeRuntime(currentId, "success", null);

          return {
            type: "video",
            lanes: outputLanes,
          } satisfies RuntimeValue;
        });
      case "llmGenerator":
        return Effect.gen(function* () {
          yield* setNodeRuntime(currentId, "running", null);

          const prompt = (yield* coerceTextInputBatch(
            state.document,
            nextPath,
            currentId,
            PROMPT_INPUT_HANDLE_ID,
            {
              message: "Connect prompt text.",
              required: true,
            },
            incomingByTarget,
            evaluateNode,
          )) as TextRuntimeValue;
          const systemPrompt = yield* coerceTextInputBatch(
            state.document,
            nextPath,
            currentId,
            SYSTEM_PROMPT_INPUT_HANDLE_ID,
            {
              message: "Connect system text.",
              required: false,
            },
            incomingByTarget,
            evaluateNode,
          );
          const mediaPlan = yield* coerceMediaInputBatches(
            state.document,
            nextPath,
            currentId,
            "image",
            incomingByTarget,
            evaluateNode,
          );
          const batchPlan = yield* coerceGeneratorExecutionBatchPlan({
            mediaPlan,
            prompt,
            systemPrompt,
          });

          yield* setActivity(
            formatRunningActivity(
              node.label,
              batchPlan.iterations,
              batchPlan.hasIterator,
            ),
          );

          const responses = yield* Effect.forEach(
            batchPlan.batches,
            (batch) =>
              params.ports.generateLlm(
                buildLlmGenerationRequest({
                  imageInputsByHandle: batch.mediaInputsByHandle,
                  prompt: batch.prompt,
                  settings: node,
                  systemPrompt: batch.systemPrompt,
                }),
              ),
            { concurrency: "unbounded" },
          );

          finalCostCredits += responses.reduce(
            (totalCost, response) =>
              totalCost +
              calculateLlmUsageCreditCost({
                model: response.model,
                usage: response.usage,
              }),
            0,
          );

          const responseText = responses
            .map((response) => response.responseText.trim())
            .filter(Boolean)
            .join("\n\n");

          yield* updateDocumentNode(currentId, (currentNode) =>
            currentNode.kind === "llmGenerator"
              ? LlmGeneratorService.setExecutionResult(currentNode, {
                  lastPrompt: formatExecutedText(
                    batchPlan.batches.map((batch) => batch.prompt),
                  ),
                  lastSystemPrompt: formatExecutedText(
                    batchPlan.batches.map((batch) => batch.systemPrompt),
                  ),
                  responseText: responseText || null,
                })
              : currentNode,
          );
          yield* setNodeRuntime(currentId, "success", null);

          return {
            type: "text",
            lanes: responses
              .map((response) => response.responseText.trim())
              .filter(Boolean),
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

    if (!targetNodeIds.length) {
      return yield* Effect.fail(
        new WorkflowValidationError({
          message: "Add a generator first.",
        }),
      );
    }

    WorkflowGraphValidator.validateExecutionTargets(
      state.document,
      targetNodeIds,
    );

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
      targetNodeIds,
      (nodeId) =>
        evaluateNode(nodeId, new Set(), nodeMap, incomingByTarget, pending),
      {
        concurrency: 1,
        discard: true,
      },
    );

    projectDocumentRevision =
      (yield* params.ports.onCompleted
        ? params.ports.onCompleted({
            document: state.document,
            finalCostCredits,
            request: params.request,
            runId: params.runId,
            targetNodeIds: executedNodeIds,
          })
        : Effect.succeed(projectDocumentRevision)) ?? projectDocumentRevision;

    state.runtime = {
      ...state.runtime,
      activity: "Workflow run finished.",
      error: null,
      finishedAt: new Date().toISOString(),
    };
    yield* setStatus("success");

    return buildWorkflowExecutionStatusResponse({
      runId: params.runId,
      targetNodeIds: executedNodeIds,
      projectDocumentRevision,
      finalCostCredits,
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
