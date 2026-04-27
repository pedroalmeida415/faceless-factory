import { Effect } from "effect";

import type { WorkflowDocument } from "~/lib/workflow/document";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import {
  buildGeneratorAssetBatchPlan,
  buildTextRuntimeValue,
  getGeneratorInputHandles,
  getIncomingEdgesForHandle,
  type RuntimeValue,
} from "~/lib/workflow/graph";

type IncomingByTarget = Map<
  string,
  Array<{
    id: string;
    source: string;
    sourceHandle: string | null;
    target: string;
    targetHandle: string | null;
  }>
>;

type EvaluateNode<E> = (
  currentId: string,
  path: ReadonlySet<string>,
  sourceHandleId?: string | null,
  requestedLaneIndex?: number | null,
) => Effect.Effect<RuntimeValue, E>;

function getInputValues<E>(
  path: ReadonlySet<string>,
  targetId: string,
  handleId: string,
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode<E>,
  requestedLaneIndex?: number | null,
) {
  const incomingEdges = getIncomingEdgesForHandle(
    incomingByTarget,
    targetId,
    handleId,
  );

  return Effect.forEach(
    incomingEdges,
    (edge) =>
      evaluateNode(edge.source, path, edge.sourceHandle, requestedLaneIndex),
    {
      concurrency: "unbounded",
    },
  );
}

export function coerceTextInputBatch<E>(
  document: WorkflowDocument,
  path: ReadonlySet<string>,
  targetId: string,
  handleId: string,
  params: {
    message: string;
    required: boolean;
  },
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode<E>,
  requestedLaneIndex?: number | null,
) {
  return Effect.gen(function* () {
    const textHandle = getGeneratorInputHandles(document, targetId).find(
      (handle) => handle.id === handleId && handle.valueType === "text",
    );

    if (!textHandle) {
      return null;
    }

    const values = yield* getInputValues(
      path,
      targetId,
      textHandle.id,
      incomingByTarget,
      evaluateNode,
      requestedLaneIndex,
    );
    const textValue = yield* Effect.try({
      try: () =>
        buildTextRuntimeValue(
          values.flatMap((value) => (value.type === "text" ? [value] : [])),
        ),
      catch: (cause) =>
        new WorkflowValidationError({
          message:
            cause instanceof Error ? cause.message : "Invalid text batch.",
          cause,
        }),
    });

    if (!textValue) {
      if (!params.required) {
        return null;
      }

      return yield* Effect.fail(
        new WorkflowValidationError({
          message: params.message,
        }),
      );
    }

    return textValue;
  });
}

export function coerceMediaInputBatches<E>(
  document: WorkflowDocument,
  path: ReadonlySet<string>,
  targetId: string,
  valueType: "image" | "video",
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode<E>,
  requestedLaneIndex?: number | null,
) {
  return Effect.gen(function* () {
    const mediaHandles = getGeneratorInputHandles(document, targetId).filter(
      (handle) => handle.valueType === valueType,
    );
    const inputValues = yield* Effect.forEach(
      mediaHandles,
      (handle) =>
        Effect.gen(function* () {
          const values = yield* getInputValues(
            path,
            targetId,
            handle.id,
            incomingByTarget,
            evaluateNode,
            requestedLaneIndex,
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

    for (const [handleId, values] of inputValues) {
      const handle = mediaHandles.find(
        (candidate) => candidate.id === handleId,
      );
      if (handle?.required && !values.length) {
        return yield* Effect.fail(
          new WorkflowValidationError({
            message: `Connect ${handle.label.toLowerCase()} ${valueType}.`,
          }),
        );
      }
    }

    return yield* Effect.try({
      try: () =>
        buildGeneratorAssetBatchPlan(
          Object.fromEntries(inputValues.filter(([, values]) => values.length)),
        ),
      catch: (cause) =>
        new WorkflowValidationError({
          message:
            cause instanceof Error
              ? cause.message
              : "Invalid generator media batch.",
          cause,
        }),
    });
  });
}
