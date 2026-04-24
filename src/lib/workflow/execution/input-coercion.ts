import { Effect } from "effect";

import type { WorkflowDocument } from "~/lib/workflow/document";
import {
  type WorkflowExecutionError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import type { WorkflowExecutionPortError } from "~/lib/workflow/execution/types";
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

type EvaluateNode = (
  currentId: string,
  path: ReadonlySet<string>,
) => Effect.Effect<
  RuntimeValue,
  WorkflowExecutionError | WorkflowExecutionPortError
>;

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

export function coerceTextInputBatch(
  document: WorkflowDocument,
  path: ReadonlySet<string>,
  targetId: string,
  handleId: string,
  params: {
    message: string;
    required: boolean;
  },
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode,
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

export function coerceMediaInputBatches(
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
