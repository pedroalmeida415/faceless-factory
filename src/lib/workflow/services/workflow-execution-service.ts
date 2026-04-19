import { Deferred, Effect } from "effect";

import type {
  WorkflowDocument,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import {
  getErrorMessage,
  WorkflowExecutionError,
  type WorkflowRequestError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import {
  buildImageGenerationRequest,
  buildVideoGenerationRequest,
} from "~/lib/workflow/generator-models";
import {
  buildGeneratorAssetBatchPlan,
  buildIncomingByTarget,
  getGeneratorInputHandles,
  getIncomingEdgesForHandle,
  type RuntimeValue,
} from "~/lib/workflow/graph";
import {
  ImageGeneratorService,
  VideoGeneratorService,
} from "~/lib/workflow/services/node-services";
import { WorkflowClientService } from "~/lib/workflow/services/workflow-client";
import { WorkflowStudioStoreService } from "~/lib/workflow/services/workflow-studio-store-service";
import { isGeneratorNodeKind } from "~/lib/workflow/types";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";

type ClientWorkflowError =
  | WorkflowExecutionError
  | WorkflowRequestError
  | WorkflowValidationError;

type IncomingByTarget = ReturnType<typeof buildIncomingByTarget>;
type PendingMap = Map<
  string,
  Deferred.Deferred<RuntimeValue, ClientWorkflowError>
>;
type NodeMap = Map<string, WorkflowDocumentNode>;
type EvaluateNode = (
  currentId: string,
  path: ReadonlySet<string>,
) => Effect.Effect<
  RuntimeValue,
  ClientWorkflowError,
  WorkflowStudioStoreService
>;

function formatRunningActivity(
  label: string,
  iterations: number,
  hasIterator: boolean,
) {
  return hasIterator
    ? `Running ${label} (${iterations} iterations)...`
    : `Running ${label}...`;
}

function getInputValues(
  path: ReadonlySet<string>,
  targetId: string,
  handleId: string,
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode,
) {
  const incomingEdges = getIncomingEdgesForHandle(
    incomingByTarget,
    targetId,
    handleId,
  );

  return Effect.forEach(
    incomingEdges,
    (edge) => evaluateNode(edge.source, path),
    {
      concurrency: "unbounded",
    },
  );
}

function coercePromptInput(
  document: WorkflowDocument,
  path: ReadonlySet<string>,
  targetId: string,
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode,
) {
  return Effect.gen(function* () {
    const promptHandle = getGeneratorInputHandles(document, targetId).find(
      (handle) => handle.valueType === "text",
    );

    if (!promptHandle) {
      return "";
    }

    const values = yield* getInputValues(
      path,
      targetId,
      promptHandle.id,
      incomingByTarget,
      evaluateNode,
    );
    const prompt = values.find((value) => value.type === "text");

    if (!prompt?.text.trim()) {
      return yield* Effect.fail(
        new WorkflowValidationError({
          message: "Connect prompt text.",
        }),
      );
    }

    return prompt.text.trim();
  });
}

function coerceMediaInputBatches(
  document: WorkflowDocument,
  path: ReadonlySet<string>,
  targetId: string,
  valueType: "image" | "video",
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode,
) {
  return Effect.gen(function* () {
    const inputValues = yield* Effect.forEach(
      getGeneratorInputHandles(document, targetId).filter(
        (handle) => handle.valueType === valueType,
      ),
      (handle) =>
        Effect.gen(function* () {
          const values = yield* getInputValues(
            path,
            targetId,
            handle.id,
            incomingByTarget,
            evaluateNode,
          );

          return [
            handle.id,
            values.flatMap((value) =>
              value.type === valueType ? [value] : [],
            ),
          ] as const;
        }),
      {
        concurrency: "unbounded",
      },
    );

    return buildGeneratorAssetBatchPlan(
      Object.fromEntries(inputValues.filter(([, values]) => values.length)),
    );
  });
}

function markNodeRuntime(
  nodeId: string,
  status: "idle" | "running" | "success" | "error",
  error: string | null,
) {
  return Effect.gen(function* () {
    const workflowStudioStore = yield* WorkflowStudioStoreService;
    yield* workflowStudioStore.setNodeRuntimeState(nodeId, status, error);
  });
}

function executeNode(
  document: WorkflowDocument,
  currentId: string,
  node: WorkflowDocumentNode,
  nextPath: ReadonlySet<string>,
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode,
): Effect.Effect<
  RuntimeValue,
  ClientWorkflowError,
  WorkflowStudioStoreService
> {
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

        yield* markNodeRuntime(currentId, "success", null);
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

        yield* markNodeRuntime(currentId, "success", null);
        return {
          type: node.assetKind,
          assets: node.assets,
          iterationMode: node.assets.length > 1 ? "iterator" : "static",
        } satisfies RuntimeValue;
      });
    case "imageGenerator":
      return Effect.gen(function* () {
        const workflowStudioStore = yield* WorkflowStudioStoreService;

        yield* workflowStudioStore.setNodeRuntimeState(
          currentId,
          "running",
          null,
        );

        const prompt = yield* coercePromptInput(
          document,
          nextPath,
          currentId,
          incomingByTarget,
          evaluateNode,
        );
        const batchPlan = yield* coerceMediaInputBatches(
          document,
          nextPath,
          currentId,
          "image",
          incomingByTarget,
          evaluateNode,
        );

        yield* workflowStudioStore.setActivity(
          formatRunningActivity(
            node.label,
            batchPlan.iterations,
            batchPlan.hasIterator,
          ),
        );

        const responses = yield* Effect.forEach(
          batchPlan.batches,
          (imageInputsByHandle) =>
            WorkflowClientService.generateImage(
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

        yield* workflowStudioStore.updateDocumentNode(
          currentId,
          (currentNode) =>
            currentNode.kind === "imageGenerator"
              ? ImageGeneratorService.setExecutionResult(currentNode, {
                  lastPrompt: prompt,
                  responseText,
                  outputAssets,
                })
              : currentNode,
        );
        yield* workflowStudioStore.setNodeRuntimeState(
          currentId,
          "success",
          null,
        );

        return {
          type: "image",
          assets: outputAssets,
          iterationMode: "static",
        } satisfies RuntimeValue;
      });
    case "videoGenerator":
      return Effect.gen(function* () {
        const workflowStudioStore = yield* WorkflowStudioStoreService;

        yield* workflowStudioStore.setNodeRuntimeState(
          currentId,
          "running",
          null,
        );

        const prompt = yield* coercePromptInput(
          document,
          nextPath,
          currentId,
          incomingByTarget,
          evaluateNode,
        );
        const batchPlan = yield* coerceMediaInputBatches(
          document,
          nextPath,
          currentId,
          "image",
          incomingByTarget,
          evaluateNode,
        );

        yield* workflowStudioStore.setActivity(
          formatRunningActivity(
            node.label,
            batchPlan.iterations,
            batchPlan.hasIterator,
          ),
        );

        const responses = yield* Effect.forEach(
          batchPlan.batches,
          (imageInputsByHandle) =>
            WorkflowClientService.generateVideo(
              buildVideoGenerationRequest({
                settings: node,
                imageInputsByHandle,
                prompt,
              }),
            ),
          { concurrency: "unbounded" },
        );

        const outputAssets = responses.flatMap((response) => response.assets);

        yield* workflowStudioStore.updateDocumentNode(
          currentId,
          (currentNode) =>
            currentNode.kind === "videoGenerator"
              ? VideoGeneratorService.setExecutionResult(currentNode, {
                  lastPrompt: prompt,
                  responseText: null,
                  outputAssets,
                })
              : currentNode,
        );
        yield* workflowStudioStore.setNodeRuntimeState(
          currentId,
          "success",
          null,
        );

        return {
          type: "video",
          assets: outputAssets,
          iterationMode: "static",
        } satisfies RuntimeValue;
      });
  }
}

function evaluateNode(
  document: WorkflowDocument,
  currentId: string,
  path: ReadonlySet<string>,
  nodeMap: NodeMap,
  incomingByTarget: IncomingByTarget,
  pending: PendingMap,
): Effect.Effect<
  RuntimeValue,
  ClientWorkflowError,
  WorkflowStudioStoreService
> {
  return Effect.suspend(() => {
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
      evaluateNode(
        document,
        nextId,
        nextPath,
        nodeMap,
        incomingByTarget,
        pending,
      );

    return Effect.gen(function* () {
      const deferred = yield* Deferred.make<
        RuntimeValue,
        ClientWorkflowError
      >();
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
            document,
            currentId,
            node,
            nextPath,
            incomingByTarget,
            recursiveEvaluateNode,
          );
        }).pipe(
          Effect.tapError((error) =>
            markNodeRuntime(currentId, "error", getErrorMessage(error)),
          ),
        ),
      );

      yield* Deferred.done(deferred, exit);
      return yield* Deferred.await(deferred);
    });
  });
}

function resolveExecutionTargets(
  document: WorkflowDocument,
  selectedNodeIds: string[],
  target: { type: "node"; nodeId: string } | { type: "selected-or-all" },
) {
  if (target.type === "node") {
    return [target.nodeId];
  }

  const selectedSet = new Set(selectedNodeIds);
  const selectedGeneratorIds = document.nodes
    .filter(
      (node) => selectedSet.has(node.id) && isGeneratorNodeKind(node.kind),
    )
    .map((node) => node.id);

  if (selectedGeneratorIds.length) {
    return selectedGeneratorIds;
  }

  return document.nodes
    .filter((node) => isGeneratorNodeKind(node.kind))
    .map((node) => node.id);
}

export const WorkflowExecutionService = {
  run(target: { type: "node"; nodeId: string } | { type: "selected-or-all" }) {
    return Effect.gen(function* () {
      const workflowStudioStore = yield* WorkflowStudioStoreService;
      const snapshot = yield* workflowStudioStore.getWorkflowSnapshot();
      const targetIds = resolveExecutionTargets(
        snapshot.document,
        snapshot.editor.selectedNodeIds,
        target,
      );

      if (!targetIds.length) {
        yield* workflowStudioStore.setActivity(
          "Add an image or video generator first.",
        );
        return;
      }

      WorkflowGraphValidator.validateExecutionTargets(
        snapshot.document,
        targetIds,
      );

      const nodeMap: NodeMap = new Map(
        snapshot.document.nodes.map((node) => [node.id, node]),
      );
      const incomingByTarget = buildIncomingByTarget(snapshot.document.edges);
      const pending: PendingMap = new Map();

      yield* Effect.forEach(
        targetIds,
        (nodeId) =>
          evaluateNode(
            snapshot.document,
            nodeId,
            new Set(),
            nodeMap,
            incomingByTarget,
            pending,
          ),
        {
          concurrency: 1,
          discard: true,
        },
      );

      yield* workflowStudioStore.setActivity("Workflow run finished.");
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const workflowStudioStore = yield* WorkflowStudioStoreService;
          yield* workflowStudioStore.setActivity(getErrorMessage(error));
        }),
      ),
    );
  },
};
