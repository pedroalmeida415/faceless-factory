import { Effect } from "effect";
import {
  buildImageBatchPlan,
  getIncomingEdgesForHandle,
  getIncomingGeneratorImageEdges,
  PROMPT_INPUT_HANDLE_ID,
} from "~/components/workflow/studio/graph";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import type { EvaluateNode, IncomingByTarget } from "./shared";

export const getInputValues = (
  path: ReadonlySet<string>,
  targetId: string,
  handleId: string,
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode,
) => {
  const incomingEdges = getIncomingEdgesForHandle(
    incomingByTarget,
    targetId,
    handleId,
  );

  return Effect.forEach(
    incomingEdges,
    (edge) => evaluateNode(edge.source, path),
    { concurrency: "unbounded" },
  );
};

export const coerceTextInput = (
  path: ReadonlySet<string>,
  targetId: string,
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode,
) =>
  Effect.gen(function* () {
    const values = yield* getInputValues(
      path,
      targetId,
      PROMPT_INPUT_HANDLE_ID,
      incomingByTarget,
      evaluateNode,
    );
    const prompt = values.find((value) => value.type === "text");

    if (!prompt?.text.trim()) {
      return yield* Effect.fail(
        new WorkflowValidationError({
          message: "Connect a prompt node with text.",
        }),
      );
    }

    return prompt.text.trim();
  });

export const coerceImageBatches = (
  path: ReadonlySet<string>,
  targetId: string,
  incomingByTarget: IncomingByTarget,
  evaluateNode: EvaluateNode,
) =>
  Effect.gen(function* () {
    const incomingEdges = getIncomingGeneratorImageEdges(
      incomingByTarget,
      targetId,
    );
    const values = yield* Effect.forEach(
      incomingEdges,
      (edge) => evaluateNode(edge.source, path),
      { concurrency: "unbounded" },
    );

    return buildImageBatchPlan(
      values.flatMap((value) => (value.type === "image" ? [value] : [])),
    );
  });
