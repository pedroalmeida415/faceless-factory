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
  getGeneratorOutputAttempt,
  getGeneratorOutputIdempotencyKey,
  getGeneratorOutputInputHash,
} from "~/lib/workflow/execution/artifact-identity";
import {
  coerceMediaInputBatches,
  coerceTextInputBatch,
} from "~/lib/workflow/execution/input-coercion";
import {
  getRuntimeValueLane,
  replaceMediaOutputLane,
  replaceTextOutputLane,
} from "~/lib/workflow/execution/output-lanes";
import {
  buildWorkflowExecutionStatusResponse,
  createWorkflowExecutionRuntimeState,
  syncWorkflowExecutionRuntimeState,
} from "~/lib/workflow/execution/runtime-state";
import {
  buildWorkflowExecutionPlan,
  getWorkflowPlannedLaneCount,
} from "~/lib/workflow/execution/subgraph";
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
  WorkflowLaneDependencyMissing,
  WorkflowReviewPause,
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
  type GeneratorExecutionBatch,
  getGeneratorInputHandles,
  getIncomingEdgesForHandle,
  getPromptNodeReferencedVariableKeys,
  getWorkflowGeneratorAwaitingReviewRuntimeValue,
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
  type WorkflowNodeStatus,
} from "~/lib/workflow/types";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";

type ExecutionError =
  | WorkflowExecutionError
  | WorkflowExecutionPortError
  | WorkflowLaneDependencyMissing
  | WorkflowReviewPause;
type PendingMap = Map<string, Deferred.Deferred<RuntimeValue, ExecutionError>>;
type NodeMap = Map<string, WorkflowDocumentNode>;
type RequestedLaneIndex = number | null | undefined;

type ExecutionState = {
  document: WorkflowDocument;
  runtime: WorkflowExecutionRuntimeState;
  status: WorkflowRunStatus;
};

type EvaluateNode = (
  currentId: string,
  path: ReadonlySet<string>,
  sourceHandleId?: string | null,
  requestedLaneIndex?: RequestedLaneIndex,
) => Effect.Effect<RuntimeValue, ExecutionError>;

function getExecutionLaneIndex(request: StartWorkflowExecutionRequest) {
  return (
    request.executionLaneFilter?.laneIndex ??
    request.reviewLaneFilter?.laneIndex ??
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

  return updateWorkflowDocumentNode(document, generatorNodeId, (node) => {
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
    return synced.node;
  });
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

function isGeneratorWorkflowNode(node: WorkflowDocumentNode) {
  return (
    node.kind === "imageGenerator" ||
    node.kind === "videoGenerator" ||
    node.kind === "llmGenerator"
  );
}

function getBroadcastLaneIndex(
  document: WorkflowDocument,
  sourceNodeId: string,
  sourceHandleId: string | null | undefined,
  requestedLaneIndex: number,
) {
  return getWorkflowPlannedLaneCount(document, sourceNodeId, sourceHandleId) ===
    1
    ? 0
    : requestedLaneIndex;
}

function getLaneMergeSourceRequest(params: {
  document: WorkflowDocument;
  incomingEdges: ReturnType<typeof getIncomingEdgesForHandle>;
  requestedLaneIndex: number;
}) {
  let offset = 0;
  for (const edge of params.incomingEdges) {
    const laneCount = getWorkflowPlannedLaneCount(
      params.document,
      edge.source,
      edge.sourceHandle,
    );
    if (params.requestedLaneIndex < offset + laneCount) {
      return {
        edge,
        laneIndex: params.requestedLaneIndex - offset,
      };
    }
    offset += laneCount;
  }

  return null;
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
  requestedLaneIndex?: RequestedLaneIndex,
) {
  return Effect.gen(function* () {
    const resolvedVariables = new Map(
      yield* Effect.forEach(
        getPromptNodeReferencedVariableKeys(node),
        (key) =>
          Effect.gen(function* () {
            const values = yield* Effect.forEach(
              getIncomingEdgesForHandle(incomingByTarget, node.id, key),
              (edge) =>
                evaluateNode(
                  edge.source,
                  path,
                  edge.sourceHandle,
                  requestedLaneIndex,
                ),
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
  document: WorkflowDocument,
  currentId: string,
  path: ReadonlySet<string>,
  incomingByTarget: ReturnType<typeof buildIncomingByTarget>,
  evaluateNode: EvaluateNode,
  laneIndex?: RequestedLaneIndex,
  laneOrder?: readonly number[],
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

  return evaluateNode(
    edge.source,
    path,
    edge.sourceHandle,
    typeof laneIndex === "number"
      ? (laneOrder?.[laneIndex] ??
          getBroadcastLaneIndex(
            document,
            edge.source,
            edge.sourceHandle,
            laneIndex,
          ))
      : laneIndex,
  );
}

function evaluateLaneTransformInputs(
  currentId: string,
  path: ReadonlySet<string>,
  incomingByTarget: ReturnType<typeof buildIncomingByTarget>,
  evaluateNode: EvaluateNode,
  requestedLaneIndex?: RequestedLaneIndex,
) {
  return Effect.forEach(
    getIncomingEdgesForHandle(
      incomingByTarget,
      currentId,
      LANE_TRANSFORM_INPUT_HANDLE_ID,
    ),
    (edge) =>
      evaluateNode(edge.source, path, edge.sourceHandle, requestedLaneIndex),
    { concurrency: "unbounded" },
  );
}

export function regenerateGeneratorReviewLane(params: {
  attempt: number;
  document: WorkflowDocument;
  laneIndex: number;
  ports: Pick<
    WorkflowExecutionPorts,
    "generateImage" | "generateVideo" | "generateLlm" | "getNodeLaneOutput"
  >;
  generatorNodeId: string;
  runId: string;
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
    const promptSnapshot = formatExecutedText(
      batchPlan.batches.map((entry) => entry.prompt),
    );
    const systemPromptSnapshot = formatExecutedText(
      batchPlan.batches.map((entry) => entry.systemPrompt),
    );

    if (sourceNode.kind === "imageGenerator") {
      const inputHash = getGeneratorOutputInputHash({
        laneIndex: params.laneIndex,
        node: sourceNode,
        promptSnapshot,
      });
      const cached = yield* params.ports.getNodeLaneOutput({
        attempt: params.attempt,
        inputHash,
        laneIndex: params.laneIndex,
        nodeId: sourceNode.id,
        runId: params.runId,
      });
      const response =
        cached?.value.type === "image"
          ? {
              assets: cached.value.lanes[0] ?? [],
              skipped: true as const,
            }
          : yield* params.ports
              .generateImage(
                buildImageGenerationRequest({
                  imageInputsByHandle: batch.mediaInputsByHandle,
                  prompt: batch.prompt,
                  settings: sourceNode,
                  idempotencyKey: getGeneratorOutputIdempotencyKey({
                    attempt: params.attempt,
                    inputHash,
                    laneIndex: params.laneIndex,
                    node: sourceNode,
                    runId: params.runId,
                  }),
                }),
              )
              .pipe(
                Effect.map((output) => ({
                  ...output,
                  skipped: false as const,
                })),
              );
      const document = updateWorkflowDocumentNode(
        params.document,
        sourceNode.id,
        (node) => {
          if (node.kind !== "imageGenerator") {
            return node;
          }
          const outputLanes = replaceMediaOutputLane(
            node.outputLanes,
            params.laneIndex,
            response.assets,
          );
          const nextNode = ImageGeneratorService.setExecutionResult(node, {
            lastPrompt: promptSnapshot,
            outputLanes,
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
                      attempt: params.attempt,
                      status: "pending",
                      text: null,
                    }
                  : lane,
              ),
              updatedAt: now,
            },
          };
        },
      );
      return {
        costCredits: response.skipped
          ? 0
          : getImageGeneratorModelCreditCost(sourceNode.model),
        document,
      };
    }

    if (sourceNode.kind === "videoGenerator") {
      const inputHash = getGeneratorOutputInputHash({
        laneIndex: params.laneIndex,
        node: sourceNode,
        promptSnapshot,
      });
      const cached = yield* params.ports.getNodeLaneOutput({
        attempt: params.attempt,
        inputHash,
        laneIndex: params.laneIndex,
        nodeId: sourceNode.id,
        runId: params.runId,
      });
      const response =
        cached?.value.type === "video"
          ? { assets: cached.value.lanes[0] ?? [], skipped: true as const }
          : yield* params.ports
              .generateVideo(
                buildVideoGenerationRequest({
                  imageInputsByHandle: batch.mediaInputsByHandle,
                  prompt: batch.prompt,
                  settings: sourceNode,
                  idempotencyKey: getGeneratorOutputIdempotencyKey({
                    attempt: params.attempt,
                    inputHash,
                    laneIndex: params.laneIndex,
                    node: sourceNode,
                    runId: params.runId,
                  }),
                }),
              )
              .pipe(
                Effect.map((output) => ({
                  ...output,
                  skipped: false as const,
                })),
              );
      const document = updateWorkflowDocumentNode(
        params.document,
        sourceNode.id,
        (node) => {
          if (node.kind !== "videoGenerator") {
            return node;
          }
          const outputLanes = replaceMediaOutputLane(
            node.outputLanes,
            params.laneIndex,
            response.assets,
          );
          const nextNode = VideoGeneratorService.setExecutionResult(node, {
            lastPrompt: promptSnapshot,
            outputLanes,
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
                      attempt: params.attempt,
                      status: "pending",
                      text: null,
                    }
                  : lane,
              ),
              updatedAt: now,
            },
          };
        },
      );
      return {
        costCredits: response.skipped
          ? 0
          : getVideoGeneratorModelCreditCost(sourceNode.model),
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

    const inputHash = getGeneratorOutputInputHash({
      laneIndex: params.laneIndex,
      node: sourceNode,
      promptSnapshot,
      systemPromptSnapshot,
    });
    const cached = yield* params.ports.getNodeLaneOutput({
      attempt: params.attempt,
      inputHash,
      laneIndex: params.laneIndex,
      nodeId: sourceNode.id,
      runId: params.runId,
    });
    const response =
      cached?.value.type === "text"
        ? {
            model: sourceNode.model,
            responseText: cached.value.lanes[0] ?? "",
            skipped: true as const,
            usage: null,
          }
        : yield* params.ports
            .generateLlm(
              buildLlmGenerationRequest({
                imageInputsByHandle: batch.mediaInputsByHandle,
                idempotencyKey: getGeneratorOutputIdempotencyKey({
                  attempt: params.attempt,
                  inputHash,
                  laneIndex: params.laneIndex,
                  node: sourceNode,
                  runId: params.runId,
                }),
                prompt: batch.prompt,
                settings: sourceNode,
                systemPrompt: batch.systemPrompt,
              }),
            )
            .pipe(
              Effect.map((output) => ({ ...output, skipped: false as const })),
            );
    const outputText = response.responseText.trim();
    const document = updateWorkflowDocumentNode(
      params.document,
      sourceNode.id,
      (node) => {
        if (node.kind !== "llmGenerator") {
          return node;
        }
        const outputLanes = replaceTextOutputLane(
          node.outputLanes,
          params.laneIndex,
          outputText,
        );
        const nextNode = LlmGeneratorService.setExecutionResult(node, {
          lastPrompt: promptSnapshot,
          lastSystemPrompt: systemPromptSnapshot,
          outputLanes,
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
                    attempt: params.attempt,
                    status: "pending",
                    text: outputText,
                  }
                : lane,
            ),
            updatedAt: now,
          },
        };
      },
    );

    if (response.skipped) {
      return { costCredits: 0, document };
    }

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
  const artifactNodeIds = Array.from(
    new Set([...executedNodeIds, ...executionPlan.reviewBarrierNodeIds]),
  );
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
      targetNodeIds: artifactNodeIds,
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

  const getRequiredNodeLaneValue = (laneDependency: {
    laneIndex: number;
    nodeId: string;
    nodeLabel: string;
  }): Effect.Effect<RuntimeValue, ExecutionError> =>
    Effect.gen(function* () {
      const value = yield* params.ports.getNodeLaneValue({
        laneIndex: laneDependency.laneIndex,
        nodeId: laneDependency.nodeId,
        runId: params.runId,
      });
      if (value) {
        return value;
      }

      return yield* Effect.fail(
        new WorkflowLaneDependencyMissing({
          laneIndex: laneDependency.laneIndex,
          nodeId: laneDependency.nodeId,
          nodeLabel: laneDependency.nodeLabel,
        }),
      );
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
    requestedLaneIndex?: RequestedLaneIndex,
  ): Effect.Effect<RuntimeValue, ExecutionError> => {
    const activeLaneIndex = requestedLaneIndex ?? executionLaneIndex;
    const storedOutput = getWorkflowGeneratorOutputRuntimeValue(node, {
      laneIndex: activeLaneIndex,
    });
    if (storedOutput && !targetNodeIdSet.has(currentId)) {
      return Effect.gen(function* () {
        yield* setNodeRuntime(currentId, "success", null);
        return storedOutput;
      });
    }

    if (
      typeof activeLaneIndex === "number" &&
      typeof executionLaneIndex === "number" &&
      isGeneratorWorkflowNode(node) &&
      ((activeLaneIndex !== executionLaneIndex &&
        targetNodeIdSet.has(currentId)) ||
        !targetNodeIdSet.has(currentId))
    ) {
      return getRequiredNodeLaneValue({
        laneIndex: activeLaneIndex,
        nodeId: currentId,
        nodeLabel: node.label,
      });
    }

    const awaitingReviewOutput = getWorkflowGeneratorAwaitingReviewRuntimeValue(
      node,
      { laneIndex: activeLaneIndex },
    );
    if (awaitingReviewOutput && !targetNodeIdSet.has(currentId)) {
      return releaseGeneratorOutputAfterReview(currentId, awaitingReviewOutput);
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
          return typeof activeLaneIndex === "number"
            ? (getRuntimeValueLane(textValue, activeLaneIndex) ?? textValue)
            : (textValue satisfies RuntimeValue);
        });
      case "prompt":
        return Effect.gen(function* () {
          const textValue = yield* evaluatePromptNodeTextBatch(
            node,
            nextPath,
            incomingByTarget,
            evaluateNode,
            activeLaneIndex,
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
          const assetValue = {
            type: node.assetKind,
            lanes: node.assets.map((asset) => [asset]),
          } satisfies RuntimeValue;
          return typeof activeLaneIndex === "number"
            ? (getRuntimeValueLane(assetValue, activeLaneIndex) ?? assetValue)
            : assetValue;
        });
      case "laneReorder":
        return Effect.gen(function* () {
          const laneOrder = yield* Effect.try({
            try: () =>
              resolveLanePermutation({
                laneCount:
                  typeof activeLaneIndex === "number"
                    ? (params.request.executionLaneFilter?.laneCount ??
                      getWorkflowPlannedLaneCount(
                        params.request.document,
                        currentId,
                      ))
                    : getWorkflowPlannedLaneCount(
                        params.request.document,
                        currentId,
                      ),
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
          const inputValue = yield* evaluateLaneReorderInput(
            state.document,
            currentId,
            nextPath,
            incomingByTarget,
            evaluateNode,
            activeLaneIndex,
            laneOrder,
          );

          if (inputValue.type !== node.valueType) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "Lane Reorder input type does not match its lane type.",
              }),
            );
          }

          yield* setNodeRuntime(currentId, "success", null);
          return typeof activeLaneIndex === "number"
            ? (inputValue satisfies RuntimeValue)
            : (reorderRuntimeValue(
                inputValue,
                laneOrder,
              ) satisfies RuntimeValue);
        });
      case "laneSelect":
        return Effect.gen(function* () {
          const inputLaneIndex =
            typeof activeLaneIndex === "number"
              ? node.indices[activeLaneIndex]
              : activeLaneIndex;
          const [inputValue] = yield* evaluateLaneTransformInputs(
            currentId,
            nextPath,
            incomingByTarget,
            evaluateNode,
            inputLaneIndex,
          );
          if (!inputValue || inputValue.type !== node.valueType) {
            return yield* Effect.fail(
              new WorkflowValidationError({ message: "Connect lane input." }),
            );
          }

          const selectedValue =
            typeof activeLaneIndex === "number"
              ? inputValue
              : yield* Effect.try({
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
          return typeof activeLaneIndex === "number"
            ? (inputValue satisfies RuntimeValue)
            : (selectedValue satisfies RuntimeValue);
        });
      case "laneSplit":
        return Effect.gen(function* () {
          const laneIndex = Number(
            (sourceHandleId ?? "lane-0").replace("lane-", ""),
          );
          const [inputValue] = yield* evaluateLaneTransformInputs(
            currentId,
            nextPath,
            incomingByTarget,
            evaluateNode,
            Number.isInteger(laneIndex) ? laneIndex : activeLaneIndex,
          );
          if (!inputValue || inputValue.type !== node.valueType) {
            return yield* Effect.fail(
              new WorkflowValidationError({ message: "Connect lane input." }),
            );
          }

          const splitValue =
            typeof activeLaneIndex === "number"
              ? inputValue
              : Number.isInteger(laneIndex)
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
          return typeof activeLaneIndex === "number"
            ? (inputValue satisfies RuntimeValue)
            : (splitValue satisfies RuntimeValue);
        });
      case "laneMerge":
      case "laneZipAlign":
        return Effect.gen(function* () {
          const incomingEdges = getIncomingEdgesForHandle(
            incomingByTarget,
            currentId,
            LANE_TRANSFORM_INPUT_HANDLE_ID,
          );
          const mergeRequest =
            typeof activeLaneIndex === "number" && node.kind === "laneMerge"
              ? getLaneMergeSourceRequest({
                  document: params.request.document,
                  incomingEdges,
                  requestedLaneIndex: activeLaneIndex,
                })
              : null;
          const laneValues = mergeRequest
            ? Effect.forEach([mergeRequest], (request) =>
                evaluateNode(
                  request.edge.source,
                  nextPath,
                  request.edge.sourceHandle,
                  request.laneIndex,
                ),
              )
            : Effect.forEach(
                incomingEdges,
                (edge) =>
                  evaluateNode(
                    edge.source,
                    nextPath,
                    edge.sourceHandle,
                    typeof activeLaneIndex === "number" &&
                      node.kind === "laneZipAlign" &&
                      node.mode === "broadcast"
                      ? getBroadcastLaneIndex(
                          params.request.document,
                          edge.source,
                          edge.sourceHandle,
                          activeLaneIndex,
                        )
                      : activeLaneIndex,
                  ),
                { concurrency: "unbounded" },
              );
          const values = (yield* laneValues).filter(
            (value) => value.type === node.valueType,
          );
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
            activeLaneIndex,
          )) as TextRuntimeValue | null;
          const mediaPlan = yield* coerceMediaInputBatches(
            state.document,
            nextPath,
            currentId,
            "image",
            incomingByTarget,
            evaluateNode,
            activeLaneIndex,
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
          const promptSnapshot = formatExecutedText(
            batchPlan.batches.map((entry) => entry.prompt),
          );

          const responses = yield* Effect.forEach(
            yield* getExecutableGeneratorBatches(
              batchPlan.batches,
              activeLaneIndex,
            ),
            ({ batch, laneIndex }) =>
              Effect.gen(function* () {
                const attempt = getGeneratorOutputAttempt(node, laneIndex);
                const inputHash = getGeneratorOutputInputHash({
                  laneIndex,
                  node,
                  promptSnapshot,
                });
                const cached = yield* params.ports.getNodeLaneOutput({
                  attempt,
                  inputHash,
                  laneIndex,
                  nodeId: currentId,
                  runId: params.runId,
                });
                const response =
                  cached?.value.type === "image"
                    ? {
                        assets: cached.value.lanes[0] ?? [],
                        skipped: true as boolean,
                      }
                    : yield* params.ports
                        .generateImage(
                          buildImageGenerationRequest({
                            idempotencyKey: getGeneratorOutputIdempotencyKey({
                              attempt,
                              inputHash,
                              laneIndex,
                              node,
                              runId: params.runId,
                            }),
                            settings: node,
                            imageInputsByHandle: batch.mediaInputsByHandle,
                            prompt: batch.prompt,
                          }),
                        )
                        .pipe(
                          Effect.map((output) => ({
                            ...output,
                            skipped: false as boolean,
                          })),
                        );

                yield* updateDocumentNode(currentId, (currentNode) => {
                  if (currentNode.kind !== "imageGenerator") {
                    return currentNode;
                  }

                  const outputLanes = replaceMediaOutputLane(
                    currentNode.outputLanes,
                    laneIndex,
                    response.assets,
                  );

                  return ImageGeneratorService.setExecutionResult(currentNode, {
                    lastPrompt: promptSnapshot,
                    outputLanes,
                  });
                });

                return response;
              }),
            { concurrency: "unbounded" },
          );

          finalCostCredits +=
            responses.filter((response) => !response.skipped).length *
            getImageGeneratorModelCreditCost(node.model);

          const responseOutputLanes = responses.map(
            (response) => response.assets,
          );
          yield* updateDocumentNode(currentId, (currentNode) => {
            if (currentNode.kind !== "imageGenerator") {
              return currentNode;
            }

            const outputLanes =
              executionLaneIndex !== null
                ? replaceMediaOutputLane(
                    currentNode.outputLanes,
                    activeLaneIndex ?? executionLaneIndex,
                    responseOutputLanes[0] ?? [],
                  )
                : responseOutputLanes;

            return ImageGeneratorService.setExecutionResult(currentNode, {
              lastPrompt: promptSnapshot,
              outputLanes,
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
            activeLaneIndex,
          )) as TextRuntimeValue | null;
          const mediaPlan = yield* coerceMediaInputBatches(
            state.document,
            nextPath,
            currentId,
            "image",
            incomingByTarget,
            evaluateNode,
            activeLaneIndex,
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
          const promptSnapshot = formatExecutedText(
            batchPlan.batches.map((entry) => entry.prompt),
          );

          const responses = yield* Effect.forEach(
            yield* getExecutableGeneratorBatches(
              batchPlan.batches,
              activeLaneIndex,
            ),
            ({ batch, laneIndex }) =>
              Effect.gen(function* () {
                const attempt = getGeneratorOutputAttempt(node, laneIndex);
                const inputHash = getGeneratorOutputInputHash({
                  laneIndex,
                  node,
                  promptSnapshot,
                });
                const cached = yield* params.ports.getNodeLaneOutput({
                  attempt,
                  inputHash,
                  laneIndex,
                  nodeId: currentId,
                  runId: params.runId,
                });
                const response =
                  cached?.value.type === "video"
                    ? {
                        assets: cached.value.lanes[0] ?? [],
                        skipped: true as boolean,
                      }
                    : yield* params.ports
                        .generateVideo(
                          buildVideoGenerationRequest({
                            idempotencyKey: getGeneratorOutputIdempotencyKey({
                              attempt,
                              inputHash,
                              laneIndex,
                              node,
                              runId: params.runId,
                            }),
                            settings: node,
                            imageInputsByHandle: batch.mediaInputsByHandle,
                            prompt: batch.prompt,
                          }),
                        )
                        .pipe(
                          Effect.map((output) => ({
                            ...output,
                            skipped: false as boolean,
                          })),
                        );

                yield* updateDocumentNode(currentId, (currentNode) => {
                  if (currentNode.kind !== "videoGenerator") {
                    return currentNode;
                  }

                  const outputLanes = replaceMediaOutputLane(
                    currentNode.outputLanes,
                    laneIndex,
                    response.assets,
                  );

                  return VideoGeneratorService.setExecutionResult(currentNode, {
                    lastPrompt: promptSnapshot,
                    outputLanes,
                  });
                });

                return response;
              }),
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
                    activeLaneIndex ?? executionLaneIndex,
                    responseOutputLanes[0] ?? [],
                  )
                : responseOutputLanes;

            return VideoGeneratorService.setExecutionResult(currentNode, {
              lastPrompt: promptSnapshot,
              outputLanes,
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
            activeLaneIndex,
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
            activeLaneIndex,
          );
          const mediaPlan = yield* coerceMediaInputBatches(
            state.document,
            nextPath,
            currentId,
            "image",
            incomingByTarget,
            evaluateNode,
            activeLaneIndex,
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
          const promptSnapshot = formatExecutedText(
            batchPlan.batches.map((entry) => entry.prompt),
          );
          const systemPromptSnapshot = formatExecutedText(
            batchPlan.batches.map((entry) => entry.systemPrompt),
          );

          const responses = yield* Effect.forEach(
            yield* getExecutableGeneratorBatches(
              batchPlan.batches,
              activeLaneIndex,
            ),
            ({ batch, laneIndex }) =>
              Effect.gen(function* () {
                const attempt = getGeneratorOutputAttempt(node, laneIndex);
                const inputHash = getGeneratorOutputInputHash({
                  laneIndex,
                  node,
                  promptSnapshot,
                  systemPromptSnapshot,
                });
                const cached = yield* params.ports.getNodeLaneOutput({
                  attempt,
                  inputHash,
                  laneIndex,
                  nodeId: currentId,
                  runId: params.runId,
                });
                const response =
                  cached?.value.type === "text"
                    ? {
                        costCredits: 0,
                        responseText: cached.value.lanes[0] ?? "",
                        skipped: true as boolean,
                      }
                    : yield* params.ports
                        .generateLlm(
                          buildLlmGenerationRequest({
                            imageInputsByHandle: batch.mediaInputsByHandle,
                            idempotencyKey: getGeneratorOutputIdempotencyKey({
                              attempt,
                              inputHash,
                              laneIndex,
                              node,
                              runId: params.runId,
                            }),
                            prompt: batch.prompt,
                            settings: node,
                            systemPrompt: batch.systemPrompt,
                          }),
                        )
                        .pipe(
                          Effect.map((output) => ({
                            costCredits: calculateLlmUsageCreditCost({
                              model: output.model,
                              usage: output.usage,
                            }),
                            responseText: output.responseText,
                            skipped: false as boolean,
                          })),
                        );

                yield* updateDocumentNode(currentId, (currentNode) => {
                  if (currentNode.kind !== "llmGenerator") {
                    return currentNode;
                  }

                  const outputLanes = replaceTextOutputLane(
                    currentNode.outputLanes,
                    laneIndex,
                    response.responseText.trim(),
                  );

                  return LlmGeneratorService.setExecutionResult(currentNode, {
                    lastPrompt: promptSnapshot,
                    lastSystemPrompt: systemPromptSnapshot,
                    outputLanes,
                  });
                });

                return response;
              }),
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
                    activeLaneIndex ?? executionLaneIndex,
                    responseOutputLanes[0] ?? "",
                  )
                : responseOutputLanes;

            return LlmGeneratorService.setExecutionResult(currentNode, {
              lastPrompt: promptSnapshot,
              lastSystemPrompt: systemPromptSnapshot,
              outputLanes,
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
    requestedLaneIndex?: RequestedLaneIndex,
  ): Effect.Effect<RuntimeValue, ExecutionError> =>
    Effect.suspend(() => {
      if (path.has(currentId)) {
        return Effect.fail(
          new WorkflowExecutionError({
            message: "Cycle detected in workflow graph.",
          }),
        );
      }

      const pendingKey = `${currentId}:${sourceHandleId ?? ""}:${requestedLaneIndex ?? "all"}`;
      const cached = pending.get(pendingKey);
      if (cached) {
        return Deferred.await(cached);
      }

      const recursiveEvaluateNode: EvaluateNode = (
        nextId,
        nextPath,
        nextSourceHandleId,
        nextRequestedLaneIndex,
      ) =>
        evaluateNode(
          nextId,
          nextPath,
          nodeMap,
          incomingByTarget,
          pending,
          nextSourceHandleId,
          nextRequestedLaneIndex,
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
              requestedLaneIndex,
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
        targetNodeIds: artifactNodeIds,
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
            targetNodeIds: artifactNodeIds,
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
      targetNodeIds: artifactNodeIds,
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
              targetNodeIds: artifactNodeIds,
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
