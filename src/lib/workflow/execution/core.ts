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
  clearMediaOutputLane,
  clearTextOutputLane,
  replaceMediaOutputLane,
  replaceTextOutputLane,
} from "~/lib/workflow/execution/output-lanes";
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
import { WorkflowReviewPause } from "~/lib/workflow/execution/types";
import {
  buildImageGenerationRequest,
  buildVideoGenerationRequest,
  getImageGeneratorModelCreditCost,
  getVideoGeneratorModelCreditCost,
} from "~/lib/workflow/generator-models";
import {
  buildGeneratorExecutionBatchPlan,
  buildIncomingByTarget,
  buildOutgoingBySource,
  buildTextRuntimeValue,
  type GeneratorExecutionBatch,
  getGeneratorInputHandles,
  getIncomingEdgesForHandle,
  getLaneAccumulatorInputValue,
  getPromptNodeReferencedVariableKeys,
  getWorkflowGeneratorOutputRuntimeValue,
  getWorkflowGeneratorRawOutputRuntimeValue,
  getWorkflowNodeRuntimeValue,
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
  LLM_ESTIMATED_CREDIT_COST,
  SYSTEM_PROMPT_INPUT_HANDLE_ID,
} from "~/lib/workflow/llm-models";
import {
  LANE_REORDER_INPUT_HANDLE_ID,
  LANE_TRANSFORM_INPUT_HANDLE_ID,
  PROMPT_INPUT_HANDLE_ID,
} from "~/lib/workflow/node-definitions";
import {
  getApprovedReviewRuntimeValue,
  isReviewFullyApproved,
  syncGeneratorReviewForOutput,
} from "~/lib/workflow/review-state";
import {
  ImageGeneratorService,
  LlmGeneratorService,
  VideoGeneratorService,
} from "~/lib/workflow/services/node-services";
import {
  isGeneratorNodeKind,
  type WorkflowAsset,
  type WorkflowNodeStatus,
} from "~/lib/workflow/types";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";

type ExecutionError =
  | WorkflowExecutionError
  | WorkflowExecutionPortError
  | WorkflowReviewPause;
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

function getExecutionLaneIndex(request: StartWorkflowExecutionRequest) {
  return (
    request.reviewLaneFilter?.laneIndex ??
    request.executionLaneFilter?.laneIndex ??
    null
  );
}

function formatLaneActivity(request: StartWorkflowExecutionRequest) {
  if (request.reviewLaneFilter) {
    return `Continuing lane ${request.reviewLaneFilter.laneIndex + 1} after review.`;
  }

  if (request.executionLaneFilter) {
    return `Running lane ${request.executionLaneFilter.laneIndex + 1} of ${request.executionLaneFilter.laneCount}.`;
  }

  return "Queued workflow run.";
}

function toRequestContext(
  request: StartWorkflowExecutionRequest,
  accruedCostCredits: number,
  documentRevision: number | null,
) {
  return {
    accruedCostCredits,
    clientRunId: request.clientRunId ?? null,
    documentRevision,
    idempotencyKey: request.idempotencyKey ?? null,
    projectId: request.projectId ?? null,
    selection: request.selection ?? null,
    target: request.target,
  } satisfies WorkflowExecutionStatusResponse["requestContext"];
}

function getStoredMediaOutputLane(
  outputLanes: readonly WorkflowAsset[][],
  laneIndex: number,
) {
  const assets = outputLanes[laneIndex];
  return assets?.length ? assets : null;
}

function getStoredTextOutputLane(
  outputLanes: readonly string[],
  laneIndex: number,
) {
  const text = outputLanes[laneIndex]?.trim();
  return text ? text : null;
}

export function clearReviewDescendantOutputLane(
  document: WorkflowDocument,
  generatorNodeId: string,
  laneIndex: number,
) {
  const outgoingBySource = buildOutgoingBySource(document.edges);
  const visited = new Set<string>();
  const stack = (outgoingBySource.get(generatorNodeId) ?? []).map(
    (edge) => edge.target,
  );
  const generatorIds = new Set<string>();

  while (stack.length) {
    const nodeId = stack.pop();
    if (!nodeId || visited.has(nodeId)) {
      continue;
    }

    visited.add(nodeId);
    const node = document.nodes.find((candidate) => candidate.id === nodeId);
    if (
      node?.kind === "imageGenerator" ||
      node?.kind === "videoGenerator" ||
      node?.kind === "llmGenerator"
    ) {
      generatorIds.add(node.id);
    }

    for (const edge of outgoingBySource.get(nodeId) ?? []) {
      stack.push(edge.target);
    }
  }

  if (!generatorIds.size) {
    return document;
  }

  return {
    ...document,
    nodes: document.nodes.map((node) => {
      if (!generatorIds.has(node.id)) {
        return node;
      }

      if (node.kind === "imageGenerator") {
        const outputLanes = clearMediaOutputLane(node.outputLanes, laneIndex);
        return ImageGeneratorService.setExecutionResult(node, {
          lastPrompt: node.lastPrompt,
          outputAssets: outputLanes.flat(),
          outputLanes,
          responseText: node.responseText,
        });
      }

      if (node.kind === "videoGenerator") {
        const outputLanes = clearMediaOutputLane(node.outputLanes, laneIndex);
        return VideoGeneratorService.setExecutionResult(node, {
          lastPrompt: node.lastPrompt,
          outputAssets: outputLanes.flat(),
          outputLanes,
          responseText: node.responseText,
        });
      }

      if (node.kind === "llmGenerator") {
        const outputLanes = clearTextOutputLane(node.outputLanes, laneIndex);
        return LlmGeneratorService.setExecutionResult(node, {
          lastPrompt: node.lastPrompt,
          lastSystemPrompt: node.lastSystemPrompt,
          outputLanes,
          responseText: outputLanes.filter(Boolean).join("\n\n") || null,
        });
      }

      return node;
    }),
  } satisfies WorkflowDocument;
}

function isReviewNodeFullyApproved(document: WorkflowDocument, nodeId: string) {
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  return isReviewFullyApproved(node);
}

function syncGeneratorReviewForGeneratedOutput(
  document: WorkflowDocument,
  generatorNodeId: string,
) {
  const sourceNode = document.nodes.find(
    (candidate) => candidate.id === generatorNodeId,
  );
  const inputValue = sourceNode
    ? getWorkflowGeneratorRawOutputRuntimeValue(sourceNode)
    : null;
  if (
    !sourceNode ||
    !inputValue ||
    (sourceNode.kind !== "imageGenerator" &&
      sourceNode.kind !== "videoGenerator" &&
      sourceNode.kind !== "llmGenerator")
  ) {
    return document;
  }

  let staleLaneIndices: number[] = [];
  const syncedDocument = updateWorkflowDocumentNode(
    document,
    generatorNodeId,
    (node) => {
      if (
        (node.kind !== "imageGenerator" &&
          node.kind !== "videoGenerator" &&
          node.kind !== "llmGenerator") ||
        !node.reviewEnabled
      ) {
        return node;
      }

      const synced = syncGeneratorReviewForOutput(node, {
        inputValue,
      });
      staleLaneIndices = synced.staleLaneIndices;
      return synced.node;
    },
  );

  return staleLaneIndices.reduce(
    (nextDocument, lane) =>
      clearReviewDescendantOutputLane(nextDocument, generatorNodeId, lane),
    syncedDocument,
  );
}

export function estimateGeneratorReviewLaneRegenerationCreditCost(params: {
  document: WorkflowDocument;
  generatorNodeId: string;
}) {
  return Effect.gen(function* () {
    const nodeMap: NodeMap = new Map(
      params.document.nodes.map((node) => [node.id, node]),
    );
    const sourceNode = nodeMap.get(params.generatorNodeId);
    if (
      !sourceNode ||
      (sourceNode.kind !== "imageGenerator" &&
        sourceNode.kind !== "videoGenerator" &&
        sourceNode.kind !== "llmGenerator")
    ) {
      return yield* Effect.fail(
        new WorkflowValidationError({
          message: "Reviewed generator node not found.",
        }),
      );
    }

    switch (sourceNode?.kind) {
      case "imageGenerator":
        return getImageGeneratorModelCreditCost(sourceNode.model);
      case "videoGenerator":
        return getVideoGeneratorModelCreditCost(sourceNode.model);
      case "llmGenerator":
        return LLM_ESTIMATED_CREDIT_COST;
      default:
        return yield* Effect.fail(
          new WorkflowValidationError({
            message: "Reviewed generator node not found.",
          }),
        );
    }
  });
}

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

function getExecutableGeneratorBatches(
  batches: readonly GeneratorExecutionBatch[],
  laneIndex: number | null | undefined,
) {
  if (laneIndex === null || laneIndex === undefined) {
    return Effect.succeed(
      batches.map((batch, index) => ({ batch, laneIndex: index })),
    );
  }

  const batch = batches[laneIndex];
  if (batch) {
    return Effect.succeed([{ batch, laneIndex }]);
  }

  if (batches.length === 1 && batches[0]) {
    return Effect.succeed([{ batch: batches[0], laneIndex }]);
  }

  return Effect.fail(
    new WorkflowValidationError({
      message: `Lane ${laneIndex + 1} is not available from the connected generator inputs.`,
    }),
  );
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

export function regenerateGeneratorReviewLane(params: {
  document: WorkflowDocument;
  idempotencyKey: string;
  laneIndex: number;
  ports: Pick<
    WorkflowExecutionPorts,
    "generateImage" | "generateVideo" | "generateLlm"
  >;
  generatorNodeId: string;
}) {
  return Effect.gen(function* () {
    const incomingByTarget = buildIncomingByTarget(params.document.edges);
    const nodeMap: NodeMap = new Map(
      params.document.nodes.map((node) => [node.id, node]),
    );
    const sourceNode = nodeMap.get(params.generatorNodeId);
    if (!sourceNode || !isGeneratorNodeKind(sourceNode.kind)) {
      return yield* Effect.fail(
        new WorkflowValidationError({
          message: "Reviewed generator node not found.",
        }),
      );
    }

    const evaluateStoredNode = (
      nodeId: string,
      path: ReadonlySet<string>,
      sourceHandleId?: string | null,
    ): Effect.Effect<
      RuntimeValue,
      WorkflowExecutionError | WorkflowExecutionPortError
    > =>
      Effect.try({
        try: () =>
          getWorkflowNodeRuntimeValue(
            params.document,
            nodeId,
            path,
            nodeMap,
            incomingByTarget,
            sourceHandleId,
          ),
        catch: (cause) =>
          new WorkflowValidationError({
            message:
              cause instanceof Error ? cause.message : "Invalid stored input.",
            cause,
          }),
      }).pipe(
        Effect.flatMap((value) =>
          value
            ? Effect.succeed(value)
            : Effect.fail(
                new WorkflowValidationError({
                  message:
                    "Cannot regenerate review lane without stored inputs.",
                }),
              ),
        ),
      );

    const prompt = (yield* coerceTextInputBatch(
      params.document,
      new Set([sourceNode.id]),
      sourceNode.id,
      PROMPT_INPUT_HANDLE_ID,
      {
        message: "Connect prompt text.",
        required:
          sourceNode.kind === "llmGenerator" ||
          isGeneratorTextInputRequired(
            params.document,
            sourceNode.id,
            PROMPT_INPUT_HANDLE_ID,
          ),
      },
      incomingByTarget,
      evaluateStoredNode,
    )) as TextRuntimeValue | null;
    const systemPrompt =
      sourceNode.kind === "llmGenerator"
        ? yield* coerceTextInputBatch(
            params.document,
            new Set([sourceNode.id]),
            sourceNode.id,
            SYSTEM_PROMPT_INPUT_HANDLE_ID,
            {
              message: "Connect system text.",
              required: false,
            },
            incomingByTarget,
            evaluateStoredNode,
          )
        : null;
    const mediaPlan = yield* coerceMediaInputBatches(
      params.document,
      new Set([sourceNode.id]),
      sourceNode.id,
      "image",
      incomingByTarget,
      evaluateStoredNode,
    );
    const batchPlan = yield* coerceGeneratorExecutionBatchPlan({
      mediaPlan,
      prompt,
      systemPrompt,
    });
    const batch = batchPlan.batches[params.laneIndex];
    if (!batch) {
      return yield* Effect.fail(
        new WorkflowValidationError({
          message: "Review lane is out of range.",
        }),
      );
    }

    const now = new Date().toISOString();

    if (sourceNode.kind === "imageGenerator") {
      const response = yield* params.ports.generateImage(
        buildImageGenerationRequest({
          imageInputsByHandle: batch.mediaInputsByHandle,
          prompt: batch.prompt,
          settings: sourceNode,
          idempotencyKey: `${params.idempotencyKey}:${sourceNode.id}:${params.laneIndex}`,
        }),
      );
      const document = clearReviewDescendantOutputLane(
        updateWorkflowDocumentNode(params.document, sourceNode.id, (node) => {
          if (node.kind !== "imageGenerator") {
            return node;
          }
          const outputLanes = replaceMediaOutputLane(
            node.outputLanes,
            params.laneIndex,
            response.assets,
          );
          const nextNode = ImageGeneratorService.setExecutionResult(node, {
            lastPrompt: formatExecutedText(
              batchPlan.batches.map((entry) => entry.prompt),
            ),
            outputAssets: outputLanes.flat(),
            outputLanes,
            responseText: node.responseText,
          });
          return {
            ...nextNode,
            review: {
              ...nextNode.review,
              lanes: nextNode.review.lanes.map((lane) =>
                lane.laneIndex === params.laneIndex
                  ? {
                      ...lane,
                      assets: response.assets,
                      attempt: lane.attempt + 1,
                      status: "pending",
                      text: null,
                    }
                  : lane,
              ),
              updatedAt: now,
            },
          };
        }),
        sourceNode.id,
        params.laneIndex,
      );
      return {
        costCredits: getImageGeneratorModelCreditCost(sourceNode.model),
        document,
      };
    }

    if (sourceNode.kind === "videoGenerator") {
      const response = yield* params.ports.generateVideo(
        buildVideoGenerationRequest({
          imageInputsByHandle: batch.mediaInputsByHandle,
          prompt: batch.prompt,
          settings: sourceNode,
          idempotencyKey: `${params.idempotencyKey}:${sourceNode.id}:${params.laneIndex}`,
        }),
      );
      const document = clearReviewDescendantOutputLane(
        updateWorkflowDocumentNode(params.document, sourceNode.id, (node) => {
          if (node.kind !== "videoGenerator") {
            return node;
          }
          const outputLanes = replaceMediaOutputLane(
            node.outputLanes,
            params.laneIndex,
            response.assets,
          );
          const nextNode = VideoGeneratorService.setExecutionResult(node, {
            lastPrompt: formatExecutedText(
              batchPlan.batches.map((entry) => entry.prompt),
            ),
            outputAssets: outputLanes.flat(),
            outputLanes,
            responseText: node.responseText,
          });
          return {
            ...nextNode,
            review: {
              ...nextNode.review,
              lanes: nextNode.review.lanes.map((lane) =>
                lane.laneIndex === params.laneIndex
                  ? {
                      ...lane,
                      assets: response.assets,
                      attempt: lane.attempt + 1,
                      status: "pending",
                      text: null,
                    }
                  : lane,
              ),
              updatedAt: now,
            },
          };
        }),
        sourceNode.id,
        params.laneIndex,
      );
      return {
        costCredits: getVideoGeneratorModelCreditCost(sourceNode.model),
        document,
      };
    }

    if (sourceNode.kind !== "llmGenerator") {
      return yield* Effect.fail(
        new WorkflowValidationError({
          message: "Reviewed generator node not found.",
        }),
      );
    }

    const response = yield* params.ports.generateLlm(
      buildLlmGenerationRequest({
        imageInputsByHandle: batch.mediaInputsByHandle,
        idempotencyKey: `${params.idempotencyKey}:${sourceNode.id}:${params.laneIndex}`,
        prompt: batch.prompt,
        settings: sourceNode,
        systemPrompt: batch.systemPrompt,
      }),
    );
    const outputText = response.responseText.trim();
    const document = clearReviewDescendantOutputLane(
      updateWorkflowDocumentNode(params.document, sourceNode.id, (node) => {
        if (node.kind !== "llmGenerator") {
          return node;
        }
        const outputLanes = replaceTextOutputLane(
          node.outputLanes,
          params.laneIndex,
          outputText,
        );
        const nextNode = LlmGeneratorService.setExecutionResult(node, {
          lastPrompt: formatExecutedText(
            batchPlan.batches.map((entry) => entry.prompt),
          ),
          lastSystemPrompt: formatExecutedText(
            batchPlan.batches.map((entry) => entry.systemPrompt),
          ),
          outputLanes,
          responseText: outputLanes.filter(Boolean).join("\n\n") || null,
        });
        return {
          ...nextNode,
          review: {
            ...nextNode.review,
            lanes: nextNode.review.lanes.map((lane) =>
              lane.laneIndex === params.laneIndex
                ? {
                    ...lane,
                    assets: [],
                    attempt: lane.attempt + 1,
                    status: "pending",
                    text: outputText,
                  }
                : lane,
            ),
            updatedAt: now,
          },
        };
      }),
      sourceNode.id,
      params.laneIndex,
    );

    return {
      costCredits: calculateLlmUsageCreditCost({
        model: response.model,
        usage: response.usage,
      }),
      document,
    };
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
  const executionLaneIndex = getExecutionLaneIndex(params.request);

  const state: ExecutionState = {
    document: params.request.document,
    runtime: createWorkflowExecutionRuntimeState(
      params.request.document,
      formatLaneActivity(params.request),
    ),
    status: params.request.reviewLaneFilter ? "waiting_for_review" : "queued",
  };
  let projectDocumentRevision = params.request.documentRevision ?? null;
  let finalCostCredits = params.request.accruedCostCredits ?? 0;

  const publish = () => {
    const response = buildWorkflowExecutionStatusResponse({
      runId: params.runId,
      targetNodeIds: executedNodeIds,
      accruedCostCredits: finalCostCredits,
      projectDocumentRevision,
      finalCostCredits: state.status === "success" ? finalCostCredits : null,
      document: state.document,
      runtime: syncWorkflowExecutionRuntimeState(state.document, state.runtime),
      requestContext: toRequestContext(
        params.request,
        finalCostCredits,
        projectDocumentRevision,
      ),
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

  const pauseFilteredLaneAtBarrier = (label: string) =>
    Effect.gen(function* () {
      const filter = params.request.reviewLaneFilter;
      if (!filter) {
        return false;
      }

      state.status = "waiting_for_review";
      yield* setActivity(
        `Lane ${filter.laneIndex + 1} is waiting at ${label} until the reviewed batch is complete.`,
      );
      return yield* Effect.fail(new WorkflowReviewPause());
    });

  const setNodeRuntime = (
    nodeId: string,
    status: WorkflowNodeStatus,
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

  const syncReviewForGenerator = (sourceNodeId: string) => {
    const nextDocument = syncGeneratorReviewForGeneratedOutput(
      state.document,
      sourceNodeId,
    );
    if (nextDocument === state.document) {
      return Effect.void;
    }

    state.document = nextDocument;
    state.runtime = syncWorkflowExecutionRuntimeState(
      state.document,
      state.runtime,
    );
    return publish();
  };

  const releaseGeneratorOutputAfterReview = (
    currentId: string,
    outputValue: RuntimeValue,
  ) =>
    Effect.gen(function* () {
      yield* syncReviewForGenerator(currentId);

      const currentNode = state.document.nodes.find(
        (candidate) => candidate.id === currentId,
      );
      if (
        !currentNode ||
        (currentNode.kind !== "imageGenerator" &&
          currentNode.kind !== "videoGenerator" &&
          currentNode.kind !== "llmGenerator")
      ) {
        return outputValue;
      }

      if (!currentNode.reviewEnabled) {
        yield* setNodeRuntime(currentId, "success", null);
        return outputValue;
      }

      const approvedValue = getApprovedReviewRuntimeValue(currentNode, {
        inputValue: outputValue,
      });
      if (approvedValue) {
        yield* setNodeRuntime(currentId, "success", null);
        return approvedValue;
      }

      state.status = "waiting_for_review";
      yield* setNodeRuntime(currentId, "waiting", null);
      yield* setActivity(`Waiting for review on ${currentNode.label}.`);
      return yield* Effect.fail(new WorkflowReviewPause());
    });

  const executeNode = (
    currentId: string,
    node: WorkflowDocumentNode,
    nextPath: ReadonlySet<string>,
    incomingByTarget: ReturnType<typeof buildIncomingByTarget>,
    evaluateNode: EvaluateNode,
    sourceHandleId?: string | null,
  ): Effect.Effect<RuntimeValue, ExecutionError> => {
    const storedOutput = getWorkflowGeneratorOutputRuntimeValue(node, {
      laneIndex: executionLaneIndex,
    });
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
      case "laneAccumulator":
        return Effect.gen(function* () {
          if (params.request.reviewLaneFilter) {
            yield* pauseFilteredLaneAtBarrier(node.label);
          }

          const inputValue = yield* Effect.try({
            try: () =>
              getLaneAccumulatorInputValue(
                state.document,
                currentId,
                nextPath,
                undefined,
                incomingByTarget,
              ),
            catch: (cause) =>
              new WorkflowValidationError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Invalid lane accumulator input.",
                cause,
              }),
          });
          if (!inputValue || inputValue.type !== node.valueType) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Lane Accumulator needs one matching input.",
              }),
            );
          }

          yield* setNodeRuntime(currentId, "success", null);
          return inputValue satisfies RuntimeValue;
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
            yield* getExecutableGeneratorBatches(
              batchPlan.batches,
              executionLaneIndex,
            ),
            ({ batch, laneIndex }) => {
              const existingNode = state.document.nodes.find(
                (candidate) => candidate.id === currentId,
              );
              const existingAssets =
                existingNode?.kind === "imageGenerator" &&
                (params.request.accruedCostCredits ?? 0) > 0
                  ? getStoredMediaOutputLane(
                      existingNode.outputLanes,
                      laneIndex,
                    )
                  : null;
              if (existingAssets?.length) {
                return Effect.succeed({
                  assets: existingAssets,
                  responseText: null as string | null,
                  skipped: true as boolean,
                });
              }

              return params.ports
                .generateImage(
                  buildImageGenerationRequest({
                    idempotencyKey: `${params.runId}:${currentId}:${laneIndex}`,
                    settings: node,
                    imageInputsByHandle: batch.mediaInputsByHandle,
                    prompt: batch.prompt,
                  }),
                )
                .pipe(
                  Effect.tap((response) =>
                    updateDocumentNode(currentId, (currentNode) => {
                      if (currentNode.kind !== "imageGenerator") {
                        return currentNode;
                      }

                      const outputLanes = replaceMediaOutputLane(
                        currentNode.outputLanes,
                        laneIndex,
                        response.assets,
                      );

                      return ImageGeneratorService.setExecutionResult(
                        currentNode,
                        {
                          lastPrompt: formatExecutedText(
                            batchPlan.batches.map((entry) => entry.prompt),
                          ),
                          outputAssets: outputLanes.flat(),
                          outputLanes,
                          responseText: currentNode.responseText,
                        },
                      );
                    }),
                  ),
                  Effect.map((response) => ({
                    ...response,
                    skipped: false as boolean,
                  })),
                );
            },
            { concurrency: "unbounded" },
          );

          finalCostCredits +=
            responses.filter((response) => !response.skipped).length *
            getImageGeneratorModelCreditCost(node.model);

          const responseOutputLanes = responses.map(
            (response) => response.assets,
          );
          const responseTextParts = responses
            .map((response) => response.responseText?.trim())
            .filter((value): value is string => Boolean(value));
          const responseText = responseTextParts.length
            ? Array.from(new Set(responseTextParts)).join("\n\n")
            : null;

          yield* updateDocumentNode(currentId, (currentNode) => {
            if (currentNode.kind !== "imageGenerator") {
              return currentNode;
            }

            const outputLanes =
              executionLaneIndex !== null
                ? replaceMediaOutputLane(
                    currentNode.outputLanes,
                    executionLaneIndex,
                    responseOutputLanes[0] ?? [],
                  )
                : responseOutputLanes;

            return ImageGeneratorService.setExecutionResult(currentNode, {
              lastPrompt: formatExecutedText(
                batchPlan.batches.map((batch) => batch.prompt),
              ),
              outputAssets: outputLanes.flat(),
              outputLanes,
              responseText,
            });
          });
          return yield* releaseGeneratorOutputAfterReview(currentId, {
            type: "image",
            lanes: responseOutputLanes,
          } satisfies RuntimeValue);
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
            yield* getExecutableGeneratorBatches(
              batchPlan.batches,
              executionLaneIndex,
            ),
            ({ batch, laneIndex }) => {
              const existingNode = state.document.nodes.find(
                (candidate) => candidate.id === currentId,
              );
              const existingAssets =
                existingNode?.kind === "videoGenerator" &&
                (params.request.accruedCostCredits ?? 0) > 0
                  ? getStoredMediaOutputLane(
                      existingNode.outputLanes,
                      laneIndex,
                    )
                  : null;
              if (existingAssets?.length) {
                return Effect.succeed({
                  assets: existingAssets,
                  skipped: true as boolean,
                });
              }

              return params.ports
                .generateVideo(
                  buildVideoGenerationRequest({
                    idempotencyKey: `${params.runId}:${currentId}:${laneIndex}`,
                    settings: node,
                    imageInputsByHandle: batch.mediaInputsByHandle,
                    prompt: batch.prompt,
                  }),
                )
                .pipe(
                  Effect.tap((response) =>
                    updateDocumentNode(currentId, (currentNode) => {
                      if (currentNode.kind !== "videoGenerator") {
                        return currentNode;
                      }

                      const outputLanes = replaceMediaOutputLane(
                        currentNode.outputLanes,
                        laneIndex,
                        response.assets,
                      );

                      return VideoGeneratorService.setExecutionResult(
                        currentNode,
                        {
                          lastPrompt: formatExecutedText(
                            batchPlan.batches.map((entry) => entry.prompt),
                          ),
                          outputAssets: outputLanes.flat(),
                          outputLanes,
                          responseText: currentNode.responseText,
                        },
                      );
                    }),
                  ),
                  Effect.map((response) => ({
                    ...response,
                    skipped: false as boolean,
                  })),
                );
            },
            { concurrency: "unbounded" },
          );

          finalCostCredits +=
            responses.filter((response) => !response.skipped).length *
            getVideoGeneratorModelCreditCost(node.model);

          const responseOutputLanes = responses.map(
            (response) => response.assets,
          );

          yield* updateDocumentNode(currentId, (currentNode) => {
            if (currentNode.kind !== "videoGenerator") {
              return currentNode;
            }

            const outputLanes =
              executionLaneIndex !== null
                ? replaceMediaOutputLane(
                    currentNode.outputLanes,
                    executionLaneIndex,
                    responseOutputLanes[0] ?? [],
                  )
                : responseOutputLanes;

            return VideoGeneratorService.setExecutionResult(currentNode, {
              lastPrompt: formatExecutedText(
                batchPlan.batches.map((batch) => batch.prompt),
              ),
              outputAssets: outputLanes.flat(),
              outputLanes,
              responseText: null,
            });
          });
          return yield* releaseGeneratorOutputAfterReview(currentId, {
            type: "video",
            lanes: responseOutputLanes,
          } satisfies RuntimeValue);
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
            yield* getExecutableGeneratorBatches(
              batchPlan.batches,
              executionLaneIndex,
            ),
            ({ batch, laneIndex }) => {
              const existingNode = state.document.nodes.find(
                (candidate) => candidate.id === currentId,
              );
              const existingText =
                existingNode?.kind === "llmGenerator" &&
                (params.request.accruedCostCredits ?? 0) > 0
                  ? getStoredTextOutputLane(existingNode.outputLanes, laneIndex)
                  : null;
              if (existingText?.trim()) {
                return Effect.succeed({
                  costCredits: 0,
                  responseText: existingText,
                  skipped: true as boolean,
                });
              }

              return params.ports
                .generateLlm(
                  buildLlmGenerationRequest({
                    imageInputsByHandle: batch.mediaInputsByHandle,
                    idempotencyKey: `${params.runId}:${currentId}:${laneIndex}`,
                    prompt: batch.prompt,
                    settings: node,
                    systemPrompt: batch.systemPrompt,
                  }),
                )
                .pipe(
                  Effect.tap((response) =>
                    updateDocumentNode(currentId, (currentNode) => {
                      if (currentNode.kind !== "llmGenerator") {
                        return currentNode;
                      }

                      const outputLanes = replaceTextOutputLane(
                        currentNode.outputLanes,
                        laneIndex,
                        response.responseText.trim(),
                      );

                      return LlmGeneratorService.setExecutionResult(
                        currentNode,
                        {
                          lastPrompt: formatExecutedText(
                            batchPlan.batches.map((entry) => entry.prompt),
                          ),
                          lastSystemPrompt: formatExecutedText(
                            batchPlan.batches.map(
                              (entry) => entry.systemPrompt,
                            ),
                          ),
                          outputLanes,
                          responseText:
                            outputLanes.filter(Boolean).join("\n\n") || null,
                        },
                      );
                    }),
                  ),
                  Effect.map((response) => ({
                    costCredits: calculateLlmUsageCreditCost({
                      model: response.model,
                      usage: response.usage,
                    }),
                    responseText: response.responseText,
                    skipped: false as boolean,
                  })),
                );
            },
            { concurrency: "unbounded" },
          );

          finalCostCredits += responses.reduce(
            (totalCost, response) => totalCost + response.costCredits,
            0,
          );

          yield* updateDocumentNode(currentId, (currentNode) => {
            if (currentNode.kind !== "llmGenerator") {
              return currentNode;
            }

            const responseOutputLanes = responses.map((response) =>
              response.responseText.trim(),
            );
            const outputLanes =
              executionLaneIndex !== null
                ? replaceTextOutputLane(
                    currentNode.outputLanes,
                    executionLaneIndex,
                    responseOutputLanes[0] ?? "",
                  )
                : responseOutputLanes;

            return LlmGeneratorService.setExecutionResult(currentNode, {
              lastPrompt: formatExecutedText(
                batchPlan.batches.map((batch) => batch.prompt),
              ),
              lastSystemPrompt: formatExecutedText(
                batchPlan.batches.map((batch) => batch.systemPrompt),
              ),
              outputLanes,
              responseText: outputLanes.filter(Boolean).join("\n\n") || null,
            });
          });
          return yield* releaseGeneratorOutputAfterReview(currentId, {
            type: "text",
            lanes: responses.map((response) => response.responseText.trim()),
          } satisfies RuntimeValue);
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
              error instanceof WorkflowReviewPause
                ? Effect.void
                : setNodeRuntime(currentId, "error", getErrorMessage(error)),
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

    state.status = params.request.reviewLaneFilter
      ? "waiting_for_review"
      : "running";
    state.runtime = {
      ...state.runtime,
      activity: params.request.reviewLaneFilter
        ? `Continuing lane ${params.request.reviewLaneFilter.laneIndex + 1} after review...`
        : params.request.executionLaneFilter
          ? `Running lane ${params.request.executionLaneFilter.laneIndex + 1} of ${params.request.executionLaneFilter.laneCount}...`
          : "Running workflow...",
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

    const reviewLaneFilter = params.request.reviewLaneFilter;
    if (
      reviewLaneFilter &&
      !isReviewNodeFullyApproved(state.document, reviewLaneFilter.reviewNodeId)
    ) {
      state.status = "waiting_for_review";
      state.runtime = {
        ...state.runtime,
        activity: `Lane ${reviewLaneFilter.laneIndex + 1} continued. Waiting for remaining reviewed lanes.`,
        nodeStateById: {
          ...state.runtime.nodeStateById,
          [reviewLaneFilter.reviewNodeId]: {
            error: null,
            status: "waiting",
          },
        },
      };
      yield* publish();

      return buildWorkflowExecutionStatusResponse({
        runId: params.runId,
        targetNodeIds: executedNodeIds,
        accruedCostCredits: finalCostCredits,
        projectDocumentRevision,
        document: state.document,
        runtime: syncWorkflowExecutionRuntimeState(
          state.document,
          state.runtime,
        ),
        requestContext: toRequestContext(
          params.request,
          finalCostCredits,
          projectDocumentRevision,
        ),
        status: state.status,
      });
    }

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
      accruedCostCredits: finalCostCredits,
      projectDocumentRevision,
      finalCostCredits,
      document: state.document,
      runtime: syncWorkflowExecutionRuntimeState(state.document, state.runtime),
      requestContext: toRequestContext(
        params.request,
        finalCostCredits,
        projectDocumentRevision,
      ),
      status: state.status,
    });
  }).pipe(
    Effect.catchAll((error) =>
      error instanceof WorkflowReviewPause
        ? Effect.succeed(
            buildWorkflowExecutionStatusResponse({
              runId: params.runId,
              targetNodeIds: executedNodeIds,
              accruedCostCredits: finalCostCredits,
              projectDocumentRevision,
              document: state.document,
              runtime: syncWorkflowExecutionRuntimeState(
                state.document,
                state.runtime,
              ),
              requestContext: toRequestContext(
                params.request,
                finalCostCredits,
                projectDocumentRevision,
              ),
              status: state.status,
            }),
          )
        : Effect.gen(function* () {
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
