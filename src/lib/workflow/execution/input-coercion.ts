import { Effect } from "effect";

import type { WorkflowDocument } from "~/lib/workflow/document";
import {
  type WorkflowExecutionError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import type { WorkflowExecutionPortError } from "~/lib/workflow/execution/types";
import {
  buildGeneratorAssetBatchPlan,
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

export function coercePromptInput(
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
