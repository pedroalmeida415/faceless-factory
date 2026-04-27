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
  laneIndex: number,
) {
  return (
    node.review.lanes.find((lane) => lane.laneIndex === laneIndex)?.attempt ?? 0
  );
}

export function getGeneratorOutputInputHash(params: {
  laneIndex: number;
  node: GeneratorWorkflowNode;
  promptSnapshot: string | null;
  systemPromptSnapshot?: string | null;
}) {
  const base = {
    config: params.node.config,
    laneIndex: params.laneIndex,
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
  laneIndex: number;
  node: GeneratorWorkflowNode;
  runId: string;
}) {
  return `${params.runId}:${params.node.id}:${params.laneIndex}:${params.attempt}:${params.node.model}:${params.inputHash}`;
}
