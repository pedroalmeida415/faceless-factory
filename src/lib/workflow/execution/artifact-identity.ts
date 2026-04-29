import { createHash } from "node:crypto";

import type { WorkflowDocument } from "~/lib/workflow/document";

type GeneratorWorkflowNode = Extract<
  WorkflowDocument["nodes"][number],
  { kind: "imageGenerator" | "videoGenerator" | "llmGenerator" }
>;

export function hashWorkflowArtifactInput(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function getGeneratorOutputAttempt(
  node: GeneratorWorkflowNode,
  outputIndex: number,
) {
  return (
    node.review.outputs.find((output) => output.outputIndex === outputIndex)
      ?.attempt ?? 0
  );
}

export function getGeneratorOutputInputHash(params: {
  outputIndex: number;
  node: GeneratorWorkflowNode;
  promptSnapshot: string | null;
  systemPromptSnapshot?: string | null;
}) {
  const base = {
    config: params.node.config,
    outputIndex: params.outputIndex,
    mode: params.node.mode,
    model: params.node.model,
    nodeId: params.node.id,
    prompt: params.promptSnapshot,
  };

  return params.node.kind === "llmGenerator"
    ? hashWorkflowArtifactInput({
        ...base,
        systemPrompt: params.systemPromptSnapshot ?? null,
      })
    : hashWorkflowArtifactInput(base);
}

export function getGeneratorOutputIdempotencyKey(params: {
  attempt: number;
  inputHash: string;
  outputIndex: number;
  node: GeneratorWorkflowNode;
  executionId: string;
}) {
  return `${params.executionId}:${params.node.id}:${params.outputIndex}:${params.attempt}:${params.node.model}:${params.inputHash}`;
}
