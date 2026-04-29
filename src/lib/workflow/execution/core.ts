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
  getRuntimeValueOutput,
  replaceMediaOutputOutput,
  replaceTextOutputOutput,
} from "~/lib/workflow/execution/node-outputs";
import {
  buildWorkflowExecutionStatusResponse,
  createWorkflowExecutionRuntimeState,
  syncWorkflowExecutionRuntimeState,
} from "~/lib/workflow/execution/runtime-state";
import {
  buildWorkflowExecutionPlan,
  getWorkflowPlannedOutputCount,
} from "~/lib/workflow/execution/subgraph";
import { resolveWorkflowExecutionTargets } from "~/lib/workflow/execution/target-resolution";
import type {
  StartWorkflowExecutionRequest,
  WorkflowExecutionPortError,
  WorkflowExecutionPorts,
  WorkflowExecutionRuntimeState,
  WorkflowExecutionStatus,
  WorkflowExecutionStatusResponse,
} from "~/lib/workflow/execution/types";
import {
  WorkflowOutputDependencyMissing,
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
  buildLlmGenerationRequest,
  calculateLlmUsageCreditCost,
  LLM_ESTIMATED_CREDIT_COST,
  SYSTEM_PROMPT_INPUT_HANDLE_ID,
} from "~/lib/workflow/llm-models";
import {
  OUTPUT_REORDER_INPUT_HANDLE_ID,
  OUTPUT_TRANSFORM_INPUT_HANDLE_ID,
  PROMPT_INPUT_HANDLE_ID,
} from "~/lib/workflow/node-definitions";
import {
  getApprovedReviewRuntimeValue,
  isReviewFullyApproved,
  syncGeneratorReviewForOutput,
} from "~/lib/workflow/review-state";
import {
  mergeRuntimeValues,
  type RuntimeValue,
  reorderRuntimeValue,
  resolveOutputPermutation,
  selectRuntimeValue,
  splitRuntimeValueOutput,
  type TextRuntimeValue,
  zipAlignRuntimeValues,
} from "~/lib/workflow/runtime-values";
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
  | WorkflowOutputDependencyMissing
  | WorkflowReviewPause;
type PendingMap = Map<string, Deferred.Deferred<RuntimeValue, ExecutionError>>;
type NodeMap = Map<string, WorkflowDocumentNode>;
type RequestedOutputIndex = number | null | undefined;

type ExecutionState = {
  document: WorkflowDocument;
  runtime: WorkflowExecutionRuntimeState;
  status: WorkflowExecutionStatus;
};

type EvaluateNode = (
  currentId: string,
  path: ReadonlySet<string>,
  sourceHandleId?: string | null,
  requestedOutputIndex?: RequestedOutputIndex,
) => Effect.Effect<RuntimeValue, ExecutionError>;

function getExecutionOutputIndex(request: StartWorkflowExecutionRequest) {
  return (
    request.executionOutputFilter?.outputIndex ??
    request.reviewOutputFilter?.outputIndex ??
    null
  );
}

function formatOutputActivity(request: StartWorkflowExecutionRequest) {
  if (request.reviewOutputFilter) {
    return `Continuing output ${request.reviewOutputFilter.outputIndex + 1} after review.`;
  }

  if (request.executionOutputFilter) {
    return `Running output ${request.executionOutputFilter.outputIndex + 1} of ${request.executionOutputFilter.outputCount}.`;
  }

  return "Queued workflow execution.";
}

function toRequestContext(
  request: StartWorkflowExecutionRequest,
  accruedCostCredits: number,
  documentRevision: number | null,
) {
  return {
    accruedCostCredits,
    clientExecutionId: request.clientExecutionId ?? null,
    documentRevision,
    idempotencyKey: request.idempotencyKey ?? null,
    projectId: request.projectId ?? null,
    selection: request.selection ?? null,
    target: request.target,
  } satisfies WorkflowExecutionStatusResponse["requestContext"];
}

function chargeOutputCost(
  ports: Pick<WorkflowExecutionPorts, "onOutputCost">,
  params: {
    amount: number;
    attempt: number;
    idempotencyKey: string;
    inputHash: string;
    nodeId: string;
    outputIndex: number;
  },
) {
  return params.amount > 0 && ports.onOutputCost
    ? ports.onOutputCost(params)
    : Effect.succeed(0);
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

export function estimateGeneratorReviewOutputRegenerationCreditCost(params: {
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
    ? `Running ${label} (${iterations} outputs)...`
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

function getBroadcastOutputIndex(
  document: WorkflowDocument,
  sourceNodeId: string,
  sourceHandleId: string | null | undefined,
  requestedOutputIndex: number,
) {
  return getWorkflowPlannedOutputCount(
    document,
    sourceNodeId,
    sourceHandleId,
  ) === 1
    ? 0
    : requestedOutputIndex;
}

function getOutputMergeSourceRequest(params: {
  document: WorkflowDocument;
  incomingEdges: ReturnType<typeof getIncomingEdgesForHandle>;
  requestedOutputIndex: number;
}) {
  let offset = 0;
  for (const edge of params.incomingEdges) {
    const outputCount = getWorkflowPlannedOutputCount(
      params.document,
      edge.source,
      edge.sourceHandle,
    );
    if (params.requestedOutputIndex < offset + outputCount) {
      return {
        edge,
        outputIndex: params.requestedOutputIndex - offset,
      };
    }
    offset += outputCount;
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
  outputIndex: number | null | undefined,
) {
  if (outputIndex === null || outputIndex === undefined) {
    return Effect.succeed(
      batches.map((batch, index) => ({ batch, outputIndex: index })),
    );
  }

  const batch = batches[outputIndex];
  if (batch) {
    return Effect.succeed([{ batch, outputIndex }]);
  }

  if (batches.length === 1 && batches[0]) {
    return Effect.succeed([{ batch: batches[0], outputIndex }]);
  }

  return Effect.fail(
    new WorkflowValidationError({
      message: `Output ${outputIndex + 1} is not available from the connected generator inputs.`,
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
  requestedOutputIndex?: RequestedOutputIndex,
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
                  requestedOutputIndex,
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

function evaluateOutputReorderInput(
  document: WorkflowDocument,
  currentId: string,
  path: ReadonlySet<string>,
  incomingByTarget: ReturnType<typeof buildIncomingByTarget>,
  evaluateNode: EvaluateNode,
  outputIndex?: RequestedOutputIndex,
  outputOrder?: readonly number[],
) {
  const incomingEdges = getIncomingEdgesForHandle(
    incomingByTarget,
    currentId,
    OUTPUT_REORDER_INPUT_HANDLE_ID,
  );
  const edge = incomingEdges[0];

  if (!edge || incomingEdges.length !== 1) {
    return Effect.fail(
      new WorkflowValidationError({
        message: "Output Reorder needs exactly one input.",
      }),
    );
  }

  return evaluateNode(
    edge.source,
    path,
    edge.sourceHandle,
    typeof outputIndex === "number"
      ? (outputOrder?.[outputIndex] ??
          getBroadcastOutputIndex(
            document,
            edge.source,
            edge.sourceHandle,
            outputIndex,
          ))
      : outputIndex,
  );
}

function evaluateOutputTransformInputs(
  currentId: string,
  path: ReadonlySet<string>,
  incomingByTarget: ReturnType<typeof buildIncomingByTarget>,
  evaluateNode: EvaluateNode,
  requestedOutputIndex?: RequestedOutputIndex,
) {
  return Effect.forEach(
    getIncomingEdgesForHandle(
      incomingByTarget,
      currentId,
      OUTPUT_TRANSFORM_INPUT_HANDLE_ID,
    ),
    (edge) =>
      evaluateNode(edge.source, path, edge.sourceHandle, requestedOutputIndex),
    { concurrency: "unbounded" },
  );
}

export function regenerateGeneratorReviewOutput(params: {
  attempt: number;
  document: WorkflowDocument;
  outputIndex: number;
  ports: Pick<
    WorkflowExecutionPorts,
    | "generateImage"
    | "generateVideo"
    | "generateLlm"
    | "getNodeOutput"
    | "onOutputCost"
  >;
  generatorNodeId: string;
  executionId: string;
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
                    "Cannot regenerate review output without stored inputs.",
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
    const batch = batchPlan.batches[params.outputIndex];
    if (!batch) {
      return yield* Effect.fail(
        new WorkflowValidationError({
          message: "Review output is out of range.",
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
        outputIndex: params.outputIndex,
        node: sourceNode,
        promptSnapshot,
      });
      const cached = yield* params.ports.getNodeOutput({
        attempt: params.attempt,
        inputHash,
        outputIndex: params.outputIndex,
        nodeId: sourceNode.id,
        executionId: params.executionId,
      });
      const response =
        cached?.value.type === "image"
          ? {
              assets: cached.value.items[0] ?? [],
              costCredits: 0,
              skipped: true as const,
            }
          : yield* Effect.gen(function* () {
              const idempotencyKey = getGeneratorOutputIdempotencyKey({
                attempt: params.attempt,
                inputHash,
                outputIndex: params.outputIndex,
                node: sourceNode,
                executionId: params.executionId,
              });
              const output = yield* params.ports.generateImage(
                buildImageGenerationRequest({
                  imageInputsByHandle: batch.mediaInputsByHandle,
                  prompt: batch.prompt,
                  settings: sourceNode,
                  idempotencyKey,
                }),
              );
              const costCredits = yield* chargeOutputCost(params.ports, {
                amount: getImageGeneratorModelCreditCost(sourceNode.model),
                attempt: params.attempt,
                idempotencyKey,
                inputHash,
                nodeId: sourceNode.id,
                outputIndex: params.outputIndex,
              });
              return { ...output, costCredits, skipped: false as const };
            });
      const document = updateWorkflowDocumentNode(
        params.document,
        sourceNode.id,
        (node) => {
          if (node.kind !== "imageGenerator") {
            return node;
          }
          const outputs = replaceMediaOutputOutput(
            node.outputs,
            params.outputIndex,
            response.assets,
          );
          const nextNode = ImageGeneratorService.setExecutionResult(node, {
            lastPrompt: promptSnapshot,
            outputs,
          });
          return {
            ...nextNode,
            review: {
              ...nextNode.review,
              outputs: nextNode.review.outputs.map((output) =>
                output.outputIndex === params.outputIndex
                  ? {
                      ...output,
                      assets: response.assets,
                      attempt: params.attempt,
                      status: "pending",
                      text: null,
                    }
                  : output,
              ),
              updatedAt: now,
            },
          };
        },
      );
      return {
        costCredits: response.costCredits,
        document,
      };
    }

    if (sourceNode.kind === "videoGenerator") {
      const inputHash = getGeneratorOutputInputHash({
        outputIndex: params.outputIndex,
        node: sourceNode,
        promptSnapshot,
      });
      const cached = yield* params.ports.getNodeOutput({
        attempt: params.attempt,
        inputHash,
        outputIndex: params.outputIndex,
        nodeId: sourceNode.id,
        executionId: params.executionId,
      });
      const response =
        cached?.value.type === "video"
          ? {
              assets: cached.value.items[0] ?? [],
              costCredits: 0,
              skipped: true as const,
            }
          : yield* Effect.gen(function* () {
              const idempotencyKey = getGeneratorOutputIdempotencyKey({
                attempt: params.attempt,
                inputHash,
                outputIndex: params.outputIndex,
                node: sourceNode,
                executionId: params.executionId,
              });
              const output = yield* params.ports.generateVideo(
                buildVideoGenerationRequest({
                  imageInputsByHandle: batch.mediaInputsByHandle,
                  prompt: batch.prompt,
                  settings: sourceNode,
                  idempotencyKey,
                }),
              );
              const costCredits = yield* chargeOutputCost(params.ports, {
                amount: getVideoGeneratorModelCreditCost(sourceNode.model),
                attempt: params.attempt,
                idempotencyKey,
                inputHash,
                nodeId: sourceNode.id,
                outputIndex: params.outputIndex,
              });
              return { ...output, costCredits, skipped: false as const };
            });
      const document = updateWorkflowDocumentNode(
        params.document,
        sourceNode.id,
        (node) => {
          if (node.kind !== "videoGenerator") {
            return node;
          }
          const outputs = replaceMediaOutputOutput(
            node.outputs,
            params.outputIndex,
            response.assets,
          );
          const nextNode = VideoGeneratorService.setExecutionResult(node, {
            lastPrompt: promptSnapshot,
            outputs,
          });
          return {
            ...nextNode,
            review: {
              ...nextNode.review,
              outputs: nextNode.review.outputs.map((output) =>
                output.outputIndex === params.outputIndex
                  ? {
                      ...output,
                      assets: response.assets,
                      attempt: params.attempt,
                      status: "pending",
                      text: null,
                    }
                  : output,
              ),
              updatedAt: now,
            },
          };
        },
      );
      return {
        costCredits: response.costCredits,
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
      outputIndex: params.outputIndex,
      node: sourceNode,
      promptSnapshot,
      systemPromptSnapshot,
    });
    const cached = yield* params.ports.getNodeOutput({
      attempt: params.attempt,
      inputHash,
      outputIndex: params.outputIndex,
      nodeId: sourceNode.id,
      executionId: params.executionId,
    });
    const response =
      cached?.value.type === "text"
        ? {
            model: sourceNode.model,
            responseText: cached.value.items[0] ?? "",
            skipped: true as const,
            costCredits: 0,
            usage: null,
          }
        : yield* Effect.gen(function* () {
            const idempotencyKey = getGeneratorOutputIdempotencyKey({
              attempt: params.attempt,
              inputHash,
              outputIndex: params.outputIndex,
              node: sourceNode,
              executionId: params.executionId,
            });
            const output = yield* params.ports.generateLlm(
              buildLlmGenerationRequest({
                imageInputsByHandle: batch.mediaInputsByHandle,
                idempotencyKey,
                prompt: batch.prompt,
                settings: sourceNode,
                systemPrompt: batch.systemPrompt,
              }),
            );
            const costCredits = yield* chargeOutputCost(params.ports, {
              amount: calculateLlmUsageCreditCost({
                model: output.model,
                usage: output.usage,
              }),
              attempt: params.attempt,
              idempotencyKey,
              inputHash,
              nodeId: sourceNode.id,
              outputIndex: params.outputIndex,
            });
            return { ...output, costCredits, skipped: false as const };
          });
    const outputText = response.responseText.trim();
    const document = updateWorkflowDocumentNode(
      params.document,
      sourceNode.id,
      (node) => {
        if (node.kind !== "llmGenerator") {
          return node;
        }
        const outputs = replaceTextOutputOutput(
          node.outputs,
          params.outputIndex,
          outputText,
        );
        const nextNode = LlmGeneratorService.setExecutionResult(node, {
          lastPrompt: promptSnapshot,
          lastSystemPrompt: systemPromptSnapshot,
          outputs,
        });
        return {
          ...nextNode,
          review: {
            ...nextNode.review,
            outputs: nextNode.review.outputs.map((output) =>
              output.outputIndex === params.outputIndex
                ? {
                    ...output,
                    assets: [],
                    attempt: params.attempt,
                    status: "pending",
                    text: outputText,
                  }
                : output,
            ),
            updatedAt: now,
          },
        };
      },
    );

    return {
      costCredits: response.costCredits,
      document,
    };
  });
}

export function executeWorkflow(params: {
  request: StartWorkflowExecutionRequest;
  executionId: string;
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
  const executionOutputIndex = getExecutionOutputIndex(params.request);

  const state: ExecutionState = {
    document: params.request.document,
    runtime: createWorkflowExecutionRuntimeState(
      params.request.document,
      formatOutputActivity(params.request),
    ),
    status: params.request.reviewOutputFilter ? "waiting_for_review" : "queued",
  };
  let projectDocumentRevision = params.request.documentRevision ?? null;
  let finalCostCredits = params.request.accruedCostCredits ?? 0;

  const publish = () => {
    const response = buildWorkflowExecutionStatusResponse({
      executionId: params.executionId,
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

  const setStatus = (status: WorkflowExecutionStatus) => {
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

  const getRequiredNodeOutputValue = (outputDependency: {
    outputIndex: number;
    nodeId: string;
    nodeLabel: string;
  }): Effect.Effect<RuntimeValue, ExecutionError> =>
    Effect.gen(function* () {
      const value = yield* params.ports.getNodeOutputValue({
        outputIndex: outputDependency.outputIndex,
        nodeId: outputDependency.nodeId,
        executionId: params.executionId,
      });
      if (value) {
        return value;
      }

      return yield* Effect.fail(
        new WorkflowOutputDependencyMissing({
          outputIndex: outputDependency.outputIndex,
          nodeId: outputDependency.nodeId,
          nodeLabel: outputDependency.nodeLabel,
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
    requestedOutputIndex?: RequestedOutputIndex,
  ): Effect.Effect<RuntimeValue, ExecutionError> => {
    const activeOutputIndex = requestedOutputIndex ?? executionOutputIndex;
    const storedOutput = getWorkflowGeneratorOutputRuntimeValue(node, {
      outputIndex: activeOutputIndex,
    });
    if (storedOutput && !targetNodeIdSet.has(currentId)) {
      return Effect.gen(function* () {
        yield* setNodeRuntime(currentId, "success", null);
        return storedOutput;
      });
    }

    if (
      typeof activeOutputIndex === "number" &&
      typeof executionOutputIndex === "number" &&
      isGeneratorWorkflowNode(node) &&
      ((activeOutputIndex !== executionOutputIndex &&
        targetNodeIdSet.has(currentId)) ||
        !targetNodeIdSet.has(currentId))
    ) {
      return getRequiredNodeOutputValue({
        outputIndex: activeOutputIndex,
        nodeId: currentId,
        nodeLabel: node.label,
      });
    }

    const awaitingReviewOutput = getWorkflowGeneratorAwaitingReviewRuntimeValue(
      node,
      { outputIndex: activeOutputIndex },
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
              items: textValues,
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
          return typeof activeOutputIndex === "number"
            ? (getRuntimeValueOutput(textValue, activeOutputIndex) ?? textValue)
            : (textValue satisfies RuntimeValue);
        });
      case "prompt":
        return Effect.gen(function* () {
          const textValue = yield* evaluatePromptNodeTextBatch(
            node,
            nextPath,
            incomingByTarget,
            evaluateNode,
            activeOutputIndex,
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
            items: node.assets.map((asset) => [asset]),
          } satisfies RuntimeValue;
          return typeof activeOutputIndex === "number"
            ? (getRuntimeValueOutput(assetValue, activeOutputIndex) ??
                assetValue)
            : assetValue;
        });
      case "outputReorder":
        return Effect.gen(function* () {
          const outputOrder = yield* Effect.try({
            try: () =>
              resolveOutputPermutation({
                outputCount:
                  typeof activeOutputIndex === "number"
                    ? (params.request.executionOutputFilter?.outputCount ??
                      getWorkflowPlannedOutputCount(
                        params.request.document,
                        currentId,
                      ))
                    : getWorkflowPlannedOutputCount(
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
                    : "Invalid output order.",
                cause,
              }),
          });
          const inputValue = yield* evaluateOutputReorderInput(
            state.document,
            currentId,
            nextPath,
            incomingByTarget,
            evaluateNode,
            activeOutputIndex,
            outputOrder,
          );

          if (inputValue.type !== node.valueType) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message:
                  "Output Reorder input type does not match its output type.",
              }),
            );
          }

          yield* setNodeRuntime(currentId, "success", null);
          return typeof activeOutputIndex === "number"
            ? (inputValue satisfies RuntimeValue)
            : (reorderRuntimeValue(
                inputValue,
                outputOrder,
              ) satisfies RuntimeValue);
        });
      case "outputSelect":
        return Effect.gen(function* () {
          const inputOutputIndex =
            typeof activeOutputIndex === "number"
              ? node.indices[activeOutputIndex]
              : activeOutputIndex;
          const [inputValue] = yield* evaluateOutputTransformInputs(
            currentId,
            nextPath,
            incomingByTarget,
            evaluateNode,
            inputOutputIndex,
          );
          if (!inputValue || inputValue.type !== node.valueType) {
            return yield* Effect.fail(
              new WorkflowValidationError({ message: "Connect output input." }),
            );
          }

          const selectedValue =
            typeof activeOutputIndex === "number"
              ? inputValue
              : yield* Effect.try({
                  try: () => selectRuntimeValue(inputValue, node.indices),
                  catch: (cause) =>
                    new WorkflowValidationError({
                      message:
                        cause instanceof Error
                          ? cause.message
                          : "Invalid output selection.",
                      cause,
                    }),
                });
          yield* setNodeRuntime(currentId, "success", null);
          return typeof activeOutputIndex === "number"
            ? (inputValue satisfies RuntimeValue)
            : (selectedValue satisfies RuntimeValue);
        });
      case "outputSplit":
        return Effect.gen(function* () {
          const outputIndex = Number(
            (sourceHandleId ?? "output-0").replace("output-", ""),
          );
          const [inputValue] = yield* evaluateOutputTransformInputs(
            currentId,
            nextPath,
            incomingByTarget,
            evaluateNode,
            Number.isInteger(outputIndex) ? outputIndex : activeOutputIndex,
          );
          if (!inputValue || inputValue.type !== node.valueType) {
            return yield* Effect.fail(
              new WorkflowValidationError({ message: "Connect output input." }),
            );
          }

          const splitValue =
            typeof activeOutputIndex === "number"
              ? inputValue
              : Number.isInteger(outputIndex)
                ? splitRuntimeValueOutput(inputValue, outputIndex)
                : null;
          if (!splitValue) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Output split output is empty.",
              }),
            );
          }

          yield* setNodeRuntime(currentId, "success", null);
          return typeof activeOutputIndex === "number"
            ? (inputValue satisfies RuntimeValue)
            : (splitValue satisfies RuntimeValue);
        });
      case "outputMerge":
      case "outputZipAlign":
        return Effect.gen(function* () {
          const incomingEdges = getIncomingEdgesForHandle(
            incomingByTarget,
            currentId,
            OUTPUT_TRANSFORM_INPUT_HANDLE_ID,
          );
          const mergeRequest =
            typeof activeOutputIndex === "number" && node.kind === "outputMerge"
              ? getOutputMergeSourceRequest({
                  document: params.request.document,
                  incomingEdges,
                  requestedOutputIndex: activeOutputIndex,
                })
              : null;
          const outputValues = mergeRequest
            ? Effect.forEach([mergeRequest], (request) =>
                evaluateNode(
                  request.edge.source,
                  nextPath,
                  request.edge.sourceHandle,
                  request.outputIndex,
                ),
              )
            : Effect.forEach(
                incomingEdges,
                (edge) =>
                  evaluateNode(
                    edge.source,
                    nextPath,
                    edge.sourceHandle,
                    typeof activeOutputIndex === "number" &&
                      node.kind === "outputZipAlign" &&
                      node.mode === "broadcast"
                      ? getBroadcastOutputIndex(
                          params.request.document,
                          edge.source,
                          edge.sourceHandle,
                          activeOutputIndex,
                        )
                      : activeOutputIndex,
                  ),
                { concurrency: "unbounded" },
              );
          const values = (yield* outputValues).filter(
            (value) => value.type === node.valueType,
          );
          const nextValue = yield* Effect.try({
            try: () =>
              node.kind === "outputMerge"
                ? mergeRuntimeValues(values)
                : zipAlignRuntimeValues(values, {
                    broadcast: node.mode === "broadcast",
                  }),
            catch: (cause) =>
              new WorkflowValidationError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Invalid output transform.",
                cause,
              }),
          });
          if (!nextValue) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Connect output inputs.",
              }),
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
            activeOutputIndex,
          )) as TextRuntimeValue | null;
          const mediaPlan = yield* coerceMediaInputBatches(
            state.document,
            nextPath,
            currentId,
            "image",
            incomingByTarget,
            evaluateNode,
            activeOutputIndex,
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
              activeOutputIndex,
            ),
            ({ batch, outputIndex }) =>
              Effect.gen(function* () {
                const attempt = getGeneratorOutputAttempt(node, outputIndex);
                const inputHash = getGeneratorOutputInputHash({
                  outputIndex,
                  node,
                  promptSnapshot,
                });
                const cached = yield* params.ports.getNodeOutput({
                  attempt,
                  inputHash,
                  outputIndex,
                  nodeId: currentId,
                  executionId: params.executionId,
                });
                const response =
                  cached?.value.type === "image"
                    ? {
                        assets: cached.value.items[0] ?? [],
                        costCredits: 0,
                        skipped: true as boolean,
                      }
                    : yield* Effect.gen(function* () {
                        const idempotencyKey = getGeneratorOutputIdempotencyKey(
                          {
                            attempt,
                            inputHash,
                            outputIndex,
                            node,
                            executionId: params.executionId,
                          },
                        );
                        const output = yield* params.ports.generateImage(
                          buildImageGenerationRequest({
                            idempotencyKey,
                            settings: node,
                            imageInputsByHandle: batch.mediaInputsByHandle,
                            prompt: batch.prompt,
                          }),
                        );
                        const costCredits = yield* chargeOutputCost(
                          params.ports,
                          {
                            amount: getImageGeneratorModelCreditCost(
                              node.model,
                            ),
                            attempt,
                            idempotencyKey,
                            inputHash,
                            nodeId: currentId,
                            outputIndex,
                          },
                        );
                        return { ...output, costCredits, skipped: false };
                      });

                yield* updateDocumentNode(currentId, (currentNode) => {
                  if (currentNode.kind !== "imageGenerator") {
                    return currentNode;
                  }

                  const outputs = replaceMediaOutputOutput(
                    currentNode.outputs,
                    outputIndex,
                    response.assets,
                  );

                  return ImageGeneratorService.setExecutionResult(currentNode, {
                    lastPrompt: promptSnapshot,
                    outputs,
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

          const responseOutputs = responses.map((response) => response.assets);
          yield* updateDocumentNode(currentId, (currentNode) => {
            if (currentNode.kind !== "imageGenerator") {
              return currentNode;
            }

            const outputs =
              executionOutputIndex !== null
                ? replaceMediaOutputOutput(
                    currentNode.outputs,
                    activeOutputIndex ?? executionOutputIndex,
                    responseOutputs[0] ?? [],
                  )
                : responseOutputs;

            return ImageGeneratorService.setExecutionResult(currentNode, {
              lastPrompt: promptSnapshot,
              outputs,
            });
          });
          return yield* releaseGeneratorOutputAfterReview(currentId, {
            type: "image",
            items: responseOutputs,
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
            activeOutputIndex,
          )) as TextRuntimeValue | null;
          const mediaPlan = yield* coerceMediaInputBatches(
            state.document,
            nextPath,
            currentId,
            "image",
            incomingByTarget,
            evaluateNode,
            activeOutputIndex,
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
              activeOutputIndex,
            ),
            ({ batch, outputIndex }) =>
              Effect.gen(function* () {
                const attempt = getGeneratorOutputAttempt(node, outputIndex);
                const inputHash = getGeneratorOutputInputHash({
                  outputIndex,
                  node,
                  promptSnapshot,
                });
                const cached = yield* params.ports.getNodeOutput({
                  attempt,
                  inputHash,
                  outputIndex,
                  nodeId: currentId,
                  executionId: params.executionId,
                });
                const response =
                  cached?.value.type === "video"
                    ? {
                        assets: cached.value.items[0] ?? [],
                        costCredits: 0,
                        skipped: true as boolean,
                      }
                    : yield* Effect.gen(function* () {
                        const idempotencyKey = getGeneratorOutputIdempotencyKey(
                          {
                            attempt,
                            inputHash,
                            outputIndex,
                            node,
                            executionId: params.executionId,
                          },
                        );
                        const output = yield* params.ports.generateVideo(
                          buildVideoGenerationRequest({
                            idempotencyKey,
                            settings: node,
                            imageInputsByHandle: batch.mediaInputsByHandle,
                            prompt: batch.prompt,
                          }),
                        );
                        const costCredits = yield* chargeOutputCost(
                          params.ports,
                          {
                            amount: getVideoGeneratorModelCreditCost(
                              node.model,
                            ),
                            attempt,
                            idempotencyKey,
                            inputHash,
                            nodeId: currentId,
                            outputIndex,
                          },
                        );
                        return { ...output, costCredits, skipped: false };
                      });

                yield* updateDocumentNode(currentId, (currentNode) => {
                  if (currentNode.kind !== "videoGenerator") {
                    return currentNode;
                  }

                  const outputs = replaceMediaOutputOutput(
                    currentNode.outputs,
                    outputIndex,
                    response.assets,
                  );

                  return VideoGeneratorService.setExecutionResult(currentNode, {
                    lastPrompt: promptSnapshot,
                    outputs,
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

          const responseOutputs = responses.map((response) => response.assets);

          yield* updateDocumentNode(currentId, (currentNode) => {
            if (currentNode.kind !== "videoGenerator") {
              return currentNode;
            }

            const outputs =
              executionOutputIndex !== null
                ? replaceMediaOutputOutput(
                    currentNode.outputs,
                    activeOutputIndex ?? executionOutputIndex,
                    responseOutputs[0] ?? [],
                  )
                : responseOutputs;

            return VideoGeneratorService.setExecutionResult(currentNode, {
              lastPrompt: promptSnapshot,
              outputs,
            });
          });
          return yield* releaseGeneratorOutputAfterReview(currentId, {
            type: "video",
            items: responseOutputs,
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
            activeOutputIndex,
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
            activeOutputIndex,
          );
          const mediaPlan = yield* coerceMediaInputBatches(
            state.document,
            nextPath,
            currentId,
            "image",
            incomingByTarget,
            evaluateNode,
            activeOutputIndex,
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
              activeOutputIndex,
            ),
            ({ batch, outputIndex }) =>
              Effect.gen(function* () {
                const attempt = getGeneratorOutputAttempt(node, outputIndex);
                const inputHash = getGeneratorOutputInputHash({
                  outputIndex,
                  node,
                  promptSnapshot,
                  systemPromptSnapshot,
                });
                const cached = yield* params.ports.getNodeOutput({
                  attempt,
                  inputHash,
                  outputIndex,
                  nodeId: currentId,
                  executionId: params.executionId,
                });
                const response =
                  cached?.value.type === "text"
                    ? {
                        costCredits: 0,
                        responseText: cached.value.items[0] ?? "",
                        skipped: true as boolean,
                      }
                    : yield* Effect.gen(function* () {
                        const idempotencyKey = getGeneratorOutputIdempotencyKey(
                          {
                            attempt,
                            inputHash,
                            outputIndex,
                            node,
                            executionId: params.executionId,
                          },
                        );
                        const output = yield* params.ports.generateLlm(
                          buildLlmGenerationRequest({
                            imageInputsByHandle: batch.mediaInputsByHandle,
                            idempotencyKey,
                            prompt: batch.prompt,
                            settings: node,
                            systemPrompt: batch.systemPrompt,
                          }),
                        );
                        const costCredits = yield* chargeOutputCost(
                          params.ports,
                          {
                            amount: calculateLlmUsageCreditCost({
                              model: output.model,
                              usage: output.usage,
                            }),
                            attempt,
                            idempotencyKey,
                            inputHash,
                            nodeId: currentId,
                            outputIndex,
                          },
                        );
                        return {
                          costCredits,
                          responseText: output.responseText,
                          skipped: false,
                        };
                      });

                yield* updateDocumentNode(currentId, (currentNode) => {
                  if (currentNode.kind !== "llmGenerator") {
                    return currentNode;
                  }

                  const outputs = replaceTextOutputOutput(
                    currentNode.outputs,
                    outputIndex,
                    response.responseText.trim(),
                  );

                  return LlmGeneratorService.setExecutionResult(currentNode, {
                    lastPrompt: promptSnapshot,
                    lastSystemPrompt: systemPromptSnapshot,
                    outputs,
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

            const responseOutputs = responses.map((response) =>
              response.responseText.trim(),
            );
            const outputs =
              executionOutputIndex !== null
                ? replaceTextOutputOutput(
                    currentNode.outputs,
                    activeOutputIndex ?? executionOutputIndex,
                    responseOutputs[0] ?? "",
                  )
                : responseOutputs;

            return LlmGeneratorService.setExecutionResult(currentNode, {
              lastPrompt: promptSnapshot,
              lastSystemPrompt: systemPromptSnapshot,
              outputs,
            });
          });
          return yield* releaseGeneratorOutputAfterReview(currentId, {
            type: "text",
            items: responses.map((response) => response.responseText.trim()),
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
    requestedOutputIndex?: RequestedOutputIndex,
  ): Effect.Effect<RuntimeValue, ExecutionError> =>
    Effect.suspend(() => {
      if (path.has(currentId)) {
        return Effect.fail(
          new WorkflowExecutionError({
            message: "Cycle detected in workflow graph.",
          }),
        );
      }

      const pendingKey = `${currentId}:${sourceHandleId ?? ""}:${requestedOutputIndex ?? "all"}`;
      const cached = pending.get(pendingKey);
      if (cached) {
        return Deferred.await(cached);
      }

      const recursiveEvaluateNode: EvaluateNode = (
        nextId,
        nextPath,
        nextSourceHandleId,
        nextRequestedOutputIndex,
      ) =>
        evaluateNode(
          nextId,
          nextPath,
          nodeMap,
          incomingByTarget,
          pending,
          nextSourceHandleId,
          nextRequestedOutputIndex,
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
              requestedOutputIndex,
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

    state.status = params.request.reviewOutputFilter
      ? "waiting_for_review"
      : "running";
    state.runtime = {
      ...state.runtime,
      activity: params.request.reviewOutputFilter
        ? `Continuing output ${params.request.reviewOutputFilter.outputIndex + 1} after review...`
        : params.request.executionOutputFilter
          ? `Running output ${params.request.executionOutputFilter.outputIndex + 1} of ${params.request.executionOutputFilter.outputCount}...`
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

    const reviewOutputFilter = params.request.reviewOutputFilter;
    if (
      reviewOutputFilter &&
      !isReviewNodeFullyApproved(
        state.document,
        reviewOutputFilter.reviewNodeId,
      )
    ) {
      state.status = "waiting_for_review";
      state.runtime = {
        ...state.runtime,
        activity: `Output ${reviewOutputFilter.outputIndex + 1} continued. Waiting for remaining reviewed outputs.`,
        nodeStateById: {
          ...state.runtime.nodeStateById,
          [reviewOutputFilter.reviewNodeId]: {
            error: null,
            status: "waiting",
          },
        },
      };
      yield* publish();

      return buildWorkflowExecutionStatusResponse({
        executionId: params.executionId,
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
            executionId: params.executionId,
            targetNodeIds: artifactNodeIds,
          })
        : Effect.succeed(projectDocumentRevision)) ?? projectDocumentRevision;

    state.runtime = {
      ...state.runtime,
      activity: "Workflow execution finished.",
      error: null,
      finishedAt: new Date().toISOString(),
    };
    yield* setStatus("success");

    return buildWorkflowExecutionStatusResponse({
      executionId: params.executionId,
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
              executionId: params.executionId,
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
