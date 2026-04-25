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
  getGeneratorInputHandles,
  getIncomingEdgesForHandle,
  getPromptNodeReferencedVariableKeys,
  getWorkflowGeneratorOutputRuntimeValue,
  resolvePromptNodeTextBatch,
} from "~/lib/workflow/graph";
import {
  mergeRuntimeValues,
  type RuntimeValue,
  reorderRuntimeValue,
  resolveLanePermutation,
  selectRuntimeValue,
  splitRuntimeValueLane,
  type TextRuntimeValue,
  zipAlignRuntimeValues,
} from "~/lib/workflow/lanes";
import {
  buildLlmGenerationRequest,
  calculateLlmUsageCreditCost,
  SYSTEM_PROMPT_INPUT_HANDLE_ID,
} from "~/lib/workflow/llm-models";
import {
  LANE_REORDER_INPUT_HANDLE_ID,
  LANE_TRANSFORM_INPUT_HANDLE_ID,
  PROMPT_INPUT_HANDLE_ID,
} from "~/lib/workflow/node-definitions";
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
  sourceHandleId?: string | null,
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

function isGeneratorTextInputRequired(
  document: WorkflowDocument,
  targetId: string,
  handleId: string,
) {
  return Boolean(
    getGeneratorInputHandles(document, targetId).find(
      (handle) => handle.id === handleId && handle.valueType === "text",
    )?.required,
  );
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
              (edge) => evaluateNode(edge.source, path, edge.sourceHandle),
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

function evaluateLaneReorderInput(
  currentId: string,
  path: ReadonlySet<string>,
  incomingByTarget: ReturnType<typeof buildIncomingByTarget>,
  evaluateNode: EvaluateNode,
) {
  const incomingEdges = getIncomingEdgesForHandle(
    incomingByTarget,
    currentId,
    LANE_REORDER_INPUT_HANDLE_ID,
  );
  const edge = incomingEdges[0];

  if (!edge || incomingEdges.length !== 1) {
    return Effect.fail(
      new WorkflowValidationError({
        message: "Lane Reorder needs exactly one input.",
      }),
    );
  }

  return evaluateNode(edge.source, path, edge.sourceHandle);
}

function evaluateLaneTransformInputs(
  currentId: string,
  path: ReadonlySet<string>,
  incomingByTarget: ReturnType<typeof buildIncomingByTarget>,
  evaluateNode: EvaluateNode,
) {
  return Effect.forEach(
    getIncomingEdgesForHandle(
      incomingByTarget,
      currentId,
      LANE_TRANSFORM_INPUT_HANDLE_ID,
    ),
    (edge) => evaluateNode(edge.source, path, edge.sourceHandle),
    { concurrency: "unbounded" },
  );
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
    sourceHandleId?: string | null,
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
      case "laneReorder":
        return Effect.gen(function* () {
          const inputValue = yield* evaluateLaneReorderInput(
            currentId,
            nextPath,
            incomingByTarget,
            evaluateNode,
          );

          if (inputValue.type !== node.valueType) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "Lane Reorder input type does not match its lane type.",
              }),
            );
          }

          const laneOrder = yield* Effect.try({
            try: () =>
              resolveLanePermutation({
                laneCount: inputValue.lanes.length,
                mode: node.mode,
                order: node.order,
                shift: node.shift,
              }),
            catch: (cause) =>
              new WorkflowValidationError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Invalid lane order.",
                cause,
              }),
          });

          yield* setNodeRuntime(currentId, "success", null);
          return reorderRuntimeValue(
            inputValue,
            laneOrder,
          ) satisfies RuntimeValue;
        });
      case "laneSelect":
        return Effect.gen(function* () {
          const [inputValue] = yield* evaluateLaneTransformInputs(
            currentId,
            nextPath,
            incomingByTarget,
            evaluateNode,
          );
          if (!inputValue || inputValue.type !== node.valueType) {
            return yield* Effect.fail(
              new WorkflowValidationError({ message: "Connect lane input." }),
            );
          }

          const selectedValue = yield* Effect.try({
            try: () => selectRuntimeValue(inputValue, node.indices),
            catch: (cause) =>
              new WorkflowValidationError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Invalid lane selection.",
                cause,
              }),
          });
          yield* setNodeRuntime(currentId, "success", null);
          return selectedValue satisfies RuntimeValue;
        });
      case "laneSplit":
        return Effect.gen(function* () {
          const [inputValue] = yield* evaluateLaneTransformInputs(
            currentId,
            nextPath,
            incomingByTarget,
            evaluateNode,
          );
          if (!inputValue || inputValue.type !== node.valueType) {
            return yield* Effect.fail(
              new WorkflowValidationError({ message: "Connect lane input." }),
            );
          }

          const laneIndex = Number(
            (sourceHandleId ?? "lane-0").replace("lane-", ""),
          );
          const splitValue = Number.isInteger(laneIndex)
            ? splitRuntimeValueLane(inputValue, laneIndex)
            : null;
          if (!splitValue) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Lane split output is empty.",
              }),
            );
          }

          yield* setNodeRuntime(currentId, "success", null);
          return splitValue satisfies RuntimeValue;
        });
      case "laneMerge":
      case "laneZipAlign":
        return Effect.gen(function* () {
          const values = (yield* evaluateLaneTransformInputs(
            currentId,
            nextPath,
            incomingByTarget,
            evaluateNode,
          )).filter((value) => value.type === node.valueType);
          const nextValue = yield* Effect.try({
            try: () =>
              node.kind === "laneMerge"
                ? mergeRuntimeValues(values)
                : zipAlignRuntimeValues(values, {
                    broadcast: node.mode === "broadcast",
                  }),
            catch: (cause) =>
              new WorkflowValidationError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Invalid lane transform.",
                cause,
              }),
          });
          if (!nextValue) {
            return yield* Effect.fail(
              new WorkflowValidationError({ message: "Connect lane inputs." }),
            );
          }

          yield* setNodeRuntime(currentId, "success", null);
          return nextValue satisfies RuntimeValue;
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
              required: isGeneratorTextInputRequired(
                state.document,
                currentId,
                PROMPT_INPUT_HANDLE_ID,
              ),
            },
            incomingByTarget,
            evaluateNode,
          )) as TextRuntimeValue | null;
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
              required: isGeneratorTextInputRequired(
                state.document,
                currentId,
                PROMPT_INPUT_HANDLE_ID,
              ),
            },
            incomingByTarget,
            evaluateNode,
          )) as TextRuntimeValue | null;
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
    sourceHandleId?: string | null,
  ): Effect.Effect<RuntimeValue, ExecutionError> =>
    Effect.suspend(() => {
      if (path.has(currentId)) {
        return Effect.fail(
          new WorkflowExecutionError({
            message: "Cycle detected in workflow graph.",
          }),
        );
      }

      const pendingKey = `${currentId}:${sourceHandleId ?? ""}`;
      const cached = pending.get(pendingKey);
      if (cached) {
        return Deferred.await(cached);
      }

      const recursiveEvaluateNode: EvaluateNode = (
        nextId,
        nextPath,
        nextSourceHandleId,
      ) =>
        evaluateNode(
          nextId,
          nextPath,
          nodeMap,
          incomingByTarget,
          pending,
          nextSourceHandleId,
        );

      return Effect.gen(function* () {
        const deferred = yield* Deferred.make<RuntimeValue, ExecutionError>();
        pending.set(pendingKey, deferred);

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
              sourceHandleId,
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
