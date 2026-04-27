import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { WorkflowDocument } from "~/lib/workflow/document";
import {
  getErrorMessage,
  WorkflowInfrastructureError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import {
  getGeneratorOutputAttempt,
  getGeneratorOutputIdempotencyKey,
  getGeneratorOutputInputHash,
} from "~/lib/workflow/execution/artifact-identity";
import type {
  LaneExecutionResult,
  NodeLaneOutputArtifact,
  NodeLaneOutputQuery,
  RegenerationAttemptRequest,
  ReviewLaneArtifact,
  WorkflowArtifactLineage,
  WorkflowRunArtifactStatus,
  WorkflowRunArtifacts,
} from "~/lib/workflow/execution/types";
import { buildIncomingByTarget } from "~/lib/workflow/graph";
import type { RuntimeValue } from "~/lib/workflow/lanes";
import type {
  WorkflowAsset,
  WorkflowReviewLaneStatus,
} from "~/lib/workflow/types";
import { isGeneratorNodeKind } from "~/lib/workflow/types";
import { db } from "~/server/db";
import {
  assets,
  workflowArtifactLineage,
  workflowNodeLaneOutputs,
  workflowReviewLanes,
} from "~/server/db/schema";

type OutputRow = typeof workflowNodeLaneOutputs.$inferSelect;
type AssetRow = typeof assets.$inferSelect;

type ArtifactStoreError = WorkflowInfrastructureError | WorkflowValidationError;
type GeneratorWorkflowNode = Extract<
  WorkflowDocument["nodes"][number],
  { kind: "imageGenerator" | "videoGenerator" | "llmGenerator" }
>;

function toArtifactStoreError(cause: unknown) {
  return cause instanceof WorkflowValidationError ||
    cause instanceof WorkflowInfrastructureError
    ? cause
    : new WorkflowInfrastructureError({
        message: getErrorMessage(cause),
        cause,
      });
}

function toWorkflowAsset(row: AssetRow): WorkflowAsset {
  return {
    createdAt: row.createdAt.toISOString(),
    externalUri: row.externalUri,
    fileName: row.fileName,
    id: row.id,
    kind: row.kind,
    mimeType: row.mimeType,
    model: row.model,
    size: row.sizeBytes,
    source: row.source,
    storagePath: row.storageKey,
    url: `/api/assets/${encodeURIComponent(row.id)}`,
  };
}

function outputValueType(node: WorkflowDocument["nodes"][number]) {
  switch (node.kind) {
    case "imageGenerator":
      return "image" as const;
    case "videoGenerator":
      return "video" as const;
    case "llmGenerator":
      return "text" as const;
    default:
      return null;
  }
}

function isGeneratorWorkflowNode(
  node: WorkflowDocument["nodes"][number] | undefined,
): node is GeneratorWorkflowNode {
  return Boolean(node && isGeneratorNodeKind(node.kind));
}

function hasGeneratorLaneOutput(
  node: GeneratorWorkflowNode,
  laneIndex: number,
) {
  return node.kind === "llmGenerator"
    ? Boolean(node.outputLanes[laneIndex]?.trim())
    : (node.outputLanes[laneIndex]?.length ?? 0) > 0;
}

function resolveSourceLaneIndex(
  node: GeneratorWorkflowNode,
  dependentLaneIndex: number,
) {
  if (hasGeneratorLaneOutput(node, dependentLaneIndex)) {
    return dependentLaneIndex;
  }

  return hasGeneratorLaneOutput(node, 0) ? 0 : null;
}

function collectUpstreamGeneratorNodeIds(
  document: WorkflowDocument,
  nodeId: string,
) {
  const incomingByTarget = buildIncomingByTarget(document.edges);
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  const generatorIds = new Set<string>();
  const visited = new Set<string>();
  const stack = (incomingByTarget.get(nodeId) ?? []).map((edge) => edge.source);

  while (stack.length) {
    const currentId = stack.pop();
    if (!currentId || visited.has(currentId)) {
      continue;
    }

    visited.add(currentId);
    const node = nodeById.get(currentId);
    if (node && isGeneratorNodeKind(node.kind)) {
      generatorIds.add(node.id);
    }

    for (const edge of incomingByTarget.get(currentId) ?? []) {
      stack.push(edge.source);
    }
  }

  return [...generatorIds];
}

function toOutputArtifact(params: {
  laneIndex: number;
  documentRevision: number | null;
  node: GeneratorWorkflowNode;
  ownerUserId: string;
  projectId: string;
  runId: string;
}) {
  const { laneIndex, node } = params;
  const attempt = getGeneratorOutputAttempt(node, laneIndex);

  if (node.kind === "llmGenerator") {
    const text = node.outputLanes[laneIndex]?.trim();
    if (!text) {
      return null;
    }
    const value = { type: "text", lanes: [text] } satisfies RuntimeValue;
    const promptSnapshot = node.lastPrompt || null;
    const inputHash = getGeneratorOutputInputHash({
      laneIndex,
      node,
      promptSnapshot,
      systemPromptSnapshot: node.lastSystemPrompt || null,
    });
    return {
      attempt,
      documentRevision: params.documentRevision,
      idempotencyKey: getGeneratorOutputIdempotencyKey({
        attempt,
        inputHash,
        laneIndex,
        node,
        runId: params.runId,
      }),
      inputHash,
      laneIndex,
      model: node.model,
      nodeId: node.id,
      ownerUserId: params.ownerUserId,
      projectId: params.projectId,
      promptSnapshot,
      runId: params.runId,
      value,
    } satisfies NodeLaneOutputArtifact;
  }

  const assets = node.outputLanes[laneIndex] ?? [];
  if (!assets.length) {
    return null;
  }
  const value = {
    type: node.kind === "imageGenerator" ? "image" : "video",
    lanes: [assets],
  } satisfies RuntimeValue;
  const promptSnapshot = node.lastPrompt || null;
  const inputHash = getGeneratorOutputInputHash({
    laneIndex,
    node,
    promptSnapshot,
  });

  return {
    attempt,
    documentRevision: params.documentRevision,
    idempotencyKey: getGeneratorOutputIdempotencyKey({
      attempt,
      inputHash,
      laneIndex,
      node,
      runId: params.runId,
    }),
    inputHash,
    laneIndex,
    model: node.model,
    nodeId: node.id,
    ownerUserId: params.ownerUserId,
    projectId: params.projectId,
    promptSnapshot,
    runId: params.runId,
    value,
  } satisfies NodeLaneOutputArtifact;
}

export function buildLaneExecutionResultFromDocument(params: {
  costCredits: number;
  document: WorkflowDocument;
  documentRevision: number | null;
  laneIndex: number | null;
  ownerUserId: string;
  projectId: string;
  runId: string;
  status: WorkflowRunArtifactStatus;
  targetNodeIds: readonly string[];
}) {
  const targetNodeIds = new Set(params.targetNodeIds);
  const laneFilter = params.laneIndex;
  const nodeById = new Map(
    params.document.nodes.map((node) => [node.id, node]),
  );
  const lineage: WorkflowArtifactLineage[] = [];
  const outputs: NodeLaneOutputArtifact[] = [];
  const reviewLanes: ReviewLaneArtifact[] = [];

  for (const node of params.document.nodes) {
    if (!targetNodeIds.has(node.id)) {
      continue;
    }
    if (
      node.kind !== "imageGenerator" &&
      node.kind !== "videoGenerator" &&
      node.kind !== "llmGenerator"
    ) {
      continue;
    }

    const laneCount = node.outputLanes.length;
    for (let laneIndex = 0; laneIndex < laneCount; laneIndex += 1) {
      if (laneFilter !== null && laneIndex !== laneFilter) {
        continue;
      }
      const output = toOutputArtifact({
        laneIndex,
        node,
        documentRevision: params.documentRevision,
        ownerUserId: params.ownerUserId,
        projectId: params.projectId,
        runId: params.runId,
      });
      if (output) {
        outputs.push(output);
        for (const sourceNodeId of collectUpstreamGeneratorNodeIds(
          params.document,
          node.id,
        )) {
          const sourceNode = nodeById.get(sourceNodeId);
          if (!isGeneratorWorkflowNode(sourceNode)) {
            continue;
          }
          const sourceLaneIndex = resolveSourceLaneIndex(sourceNode, laneIndex);
          if (sourceLaneIndex === null) {
            continue;
          }
          lineage.push({
            dependentAttempt: output.attempt,
            dependentLaneIndex: output.laneIndex,
            dependentNodeId: output.nodeId,
            runId: output.runId,
            sourceAttempt: getGeneratorOutputAttempt(
              sourceNode,
              sourceLaneIndex,
            ),
            sourceLaneIndex,
            sourceNodeId,
          });
        }
      }
    }

    const valueType = outputValueType(node);
    if (!valueType || !node.reviewEnabled) {
      continue;
    }
    reviewLanes.push(
      ...node.review.lanes
        .filter((lane) => laneFilter === null || lane.laneIndex === laneFilter)
        .map(
          (lane) =>
            ({
              attempt: lane.attempt,
              laneIndex: lane.laneIndex,
              nodeId: node.id,
              ownerUserId: params.ownerUserId,
              projectId: params.projectId,
              runId: params.runId,
              status: lane.status,
              valueType,
            }) satisfies ReviewLaneArtifact,
        ),
    );
  }

  return {
    costCredits: params.costCredits,
    laneIndex: params.laneIndex,
    lineage,
    outputs,
    reviewLanes,
    runId: params.runId,
    status: params.status,
  } satisfies LaneExecutionResult;
}

function outputToRowValue(output: NodeLaneOutputArtifact) {
  if (output.value.type === "text") {
    return {
      assetIds: [],
      textValue: output.value.lanes[0] ?? "",
      valueType: output.value.type,
    };
  }

  return {
    assetIds: output.value.lanes[0]?.map((asset) => asset.id) ?? [],
    textValue: null,
    valueType: output.value.type,
  };
}

function rowToOutput(row: OutputRow, assetById: Map<string, WorkflowAsset>) {
  const value =
    row.valueType === "text"
      ? ({ type: "text", lanes: [row.textValue ?? ""] } satisfies RuntimeValue)
      : ({
          type: row.valueType,
          lanes: [
            row.assetIds.flatMap((assetId) => assetById.get(assetId) ?? []),
          ],
        } satisfies RuntimeValue);

  return {
    attempt: row.attempt,
    documentRevision: null,
    idempotencyKey: row.idempotencyKey,
    inputHash: row.inputHash,
    laneIndex: row.laneIndex,
    model: row.model,
    nodeId: row.nodeId,
    ownerUserId: row.ownerUserId,
    projectId: row.projectId,
    promptSnapshot: row.promptSnapshot,
    runId: row.runId,
    value,
  } satisfies NodeLaneOutputArtifact;
}

function getRunArtifactsEffect(params: { ownerUserId: string; runId: string }) {
  return Effect.tryPromise({
    try: async () => {
      const [outputRows, reviewRows, lineageRows] = await Promise.all([
        db
          .select()
          .from(workflowNodeLaneOutputs)
          .where(
            and(
              eq(workflowNodeLaneOutputs.runId, params.runId),
              eq(workflowNodeLaneOutputs.ownerUserId, params.ownerUserId),
            ),
          ),
        db
          .select()
          .from(workflowReviewLanes)
          .where(
            and(
              eq(workflowReviewLanes.runId, params.runId),
              eq(workflowReviewLanes.ownerUserId, params.ownerUserId),
            ),
          ),
        db
          .select()
          .from(workflowArtifactLineage)
          .where(eq(workflowArtifactLineage.runId, params.runId)),
      ]);
      const assetIds = Array.from(
        new Set(outputRows.flatMap((row) => row.assetIds)),
      );
      const assetRows = assetIds.length
        ? await db
            .select()
            .from(assets)
            .where(
              and(
                eq(assets.ownerUserId, params.ownerUserId),
                inArray(assets.id, assetIds),
              ),
            )
        : [];
      const assetById = new Map(
        assetRows.map((row) => [row.id, toWorkflowAsset(row)]),
      );
      return {
        lineage: lineageRows.map(
          (row) =>
            ({
              dependentAttempt: row.dependentAttempt,
              dependentLaneIndex: row.dependentLaneIndex,
              dependentNodeId: row.dependentNodeId,
              runId: row.runId,
              sourceAttempt: row.sourceAttempt,
              sourceLaneIndex: row.sourceLaneIndex,
              sourceNodeId: row.sourceNodeId,
            }) satisfies WorkflowArtifactLineage,
        ),
        outputs: outputRows.map((row) => rowToOutput(row, assetById)),
        reviewLanes: reviewRows.map(
          (row) =>
            ({
              attempt: row.attempt,
              laneIndex: row.laneIndex,
              nodeId: row.nodeId,
              ownerUserId: row.ownerUserId,
              projectId: row.projectId,
              runId: row.runId,
              status: row.status,
              valueType: row.valueType,
            }) satisfies ReviewLaneArtifact,
        ),
      } satisfies WorkflowRunArtifacts;
    },
    catch: toArtifactStoreError,
  });
}

function getNodeLaneOutputEffect(params: NodeLaneOutputQuery) {
  return Effect.tryPromise({
    try: async () => {
      const output = await db
        .select()
        .from(workflowNodeLaneOutputs)
        .where(
          and(
            eq(workflowNodeLaneOutputs.runId, params.runId),
            eq(workflowNodeLaneOutputs.ownerUserId, params.ownerUserId),
            eq(workflowNodeLaneOutputs.nodeId, params.nodeId),
            eq(workflowNodeLaneOutputs.laneIndex, params.laneIndex),
            eq(workflowNodeLaneOutputs.attempt, params.attempt),
            eq(workflowNodeLaneOutputs.inputHash, params.inputHash),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!output) {
        return null;
      }

      const assetRows = output.assetIds.length
        ? await db
            .select()
            .from(assets)
            .where(
              and(
                eq(assets.ownerUserId, params.ownerUserId),
                inArray(assets.id, output.assetIds),
              ),
            )
        : [];
      const assetById = new Map(
        assetRows.map((row) => [row.id, toWorkflowAsset(row)]),
      );
      return rowToOutput(output, assetById);
    },
    catch: toArtifactStoreError,
  });
}

export class WorkflowArtifactStore extends Context.Tag("WorkflowArtifactStore")<
  WorkflowArtifactStore,
  {
    readonly createNextAttempt: (
      params: RegenerationAttemptRequest,
    ) => Effect.Effect<number, ArtifactStoreError>;
    readonly getRunArtifacts: (params: {
      ownerUserId: string;
      runId: string;
    }) => Effect.Effect<WorkflowRunArtifacts, ArtifactStoreError>;
    readonly getNodeLaneOutput: (
      params: NodeLaneOutputQuery,
    ) => Effect.Effect<NodeLaneOutputArtifact | null, ArtifactStoreError>;
    readonly setReviewLaneStatus: (params: {
      attempt?: number | null;
      laneIndex: number;
      nodeId: string;
      ownerUserId: string;
      runId: string;
      status: WorkflowReviewLaneStatus;
    }) => Effect.Effect<void, ArtifactStoreError>;
    readonly upsertLaneExecutionResult: (
      result: LaneExecutionResult,
    ) => Effect.Effect<void, ArtifactStoreError>;
  }
>() {
  static readonly Live = Layer.succeed(
    this,
    WorkflowArtifactStore.of({
      createNextAttempt: (params) =>
        Effect.tryPromise({
          try: async () => {
            const [outputRows, reviewRows] = await Promise.all([
              db
                .select({ attempt: workflowNodeLaneOutputs.attempt })
                .from(workflowNodeLaneOutputs)
                .where(
                  and(
                    eq(workflowNodeLaneOutputs.runId, params.runId),
                    eq(workflowNodeLaneOutputs.ownerUserId, params.ownerUserId),
                    eq(workflowNodeLaneOutputs.nodeId, params.nodeId),
                    eq(workflowNodeLaneOutputs.laneIndex, params.laneIndex),
                  ),
                ),
              db
                .select({ attempt: workflowReviewLanes.attempt })
                .from(workflowReviewLanes)
                .where(
                  and(
                    eq(workflowReviewLanes.runId, params.runId),
                    eq(workflowReviewLanes.ownerUserId, params.ownerUserId),
                    eq(workflowReviewLanes.nodeId, params.nodeId),
                    eq(workflowReviewLanes.laneIndex, params.laneIndex),
                  ),
                ),
            ]);
            const latestAttempt = Math.max(
              -1,
              ...outputRows.map((row) => row.attempt),
              ...reviewRows.map((row) => row.attempt),
            );
            if (latestAttempt >= 0) {
              await db
                .update(workflowReviewLanes)
                .set({ status: "regenerating", updatedAt: new Date() })
                .where(
                  and(
                    eq(workflowReviewLanes.runId, params.runId),
                    eq(workflowReviewLanes.ownerUserId, params.ownerUserId),
                    eq(workflowReviewLanes.nodeId, params.nodeId),
                    eq(workflowReviewLanes.laneIndex, params.laneIndex),
                    eq(workflowReviewLanes.attempt, latestAttempt),
                  ),
                );
            }
            return latestAttempt + 1;
          },
          catch: toArtifactStoreError,
        }),
      getRunArtifacts: getRunArtifactsEffect,
      getNodeLaneOutput: getNodeLaneOutputEffect,
      setReviewLaneStatus: (params) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select({ attempt: workflowReviewLanes.attempt })
              .from(workflowReviewLanes)
              .where(
                and(
                  eq(workflowReviewLanes.runId, params.runId),
                  eq(workflowReviewLanes.ownerUserId, params.ownerUserId),
                  eq(workflowReviewLanes.nodeId, params.nodeId),
                  eq(workflowReviewLanes.laneIndex, params.laneIndex),
                ),
              );
            const attempt =
              params.attempt ?? Math.max(-1, ...rows.map((row) => row.attempt));
            if (attempt < 0) {
              throw new WorkflowValidationError({
                message: `Review lane ${params.laneIndex + 1} does not exist.`,
              });
            }
            await db
              .update(workflowReviewLanes)
              .set({ status: params.status, updatedAt: new Date() })
              .where(
                and(
                  eq(workflowReviewLanes.runId, params.runId),
                  eq(workflowReviewLanes.ownerUserId, params.ownerUserId),
                  eq(workflowReviewLanes.nodeId, params.nodeId),
                  eq(workflowReviewLanes.laneIndex, params.laneIndex),
                  eq(workflowReviewLanes.attempt, attempt),
                ),
              );
          },
          catch: toArtifactStoreError,
        }),
      upsertLaneExecutionResult: (result) =>
        Effect.tryPromise({
          try: async () => {
            const now = new Date();
            for (const output of result.outputs) {
              const rowValue = outputToRowValue(output);
              await db
                .insert(workflowNodeLaneOutputs)
                .values({
                  ...rowValue,
                  attempt: output.attempt,
                  createdAt: now,
                  id: randomUUID(),
                  idempotencyKey: output.idempotencyKey,
                  inputHash: output.inputHash,
                  laneIndex: output.laneIndex,
                  model: output.model,
                  nodeId: output.nodeId,
                  ownerUserId: output.ownerUserId,
                  projectId: output.projectId,
                  promptSnapshot: output.promptSnapshot,
                  runId: output.runId,
                })
                .onConflictDoUpdate({
                  target: [
                    workflowNodeLaneOutputs.runId,
                    workflowNodeLaneOutputs.nodeId,
                    workflowNodeLaneOutputs.laneIndex,
                    workflowNodeLaneOutputs.attempt,
                  ],
                  set: {
                    assetIds: rowValue.assetIds,
                    inputHash: output.inputHash,
                    model: output.model,
                    promptSnapshot: output.promptSnapshot,
                    textValue: rowValue.textValue,
                    valueType: rowValue.valueType,
                  },
                });

              if (rowValue.assetIds.length) {
                await db
                  .update(assets)
                  .set({
                    projectId: output.projectId,
                    workflowDocumentRevision: output.documentRevision,
                    workflowAttempt: output.attempt,
                    workflowLaneIndex: output.laneIndex,
                    workflowNodeId: output.nodeId,
                    workflowRunId: output.runId,
                  })
                  .where(
                    and(
                      eq(assets.ownerUserId, output.ownerUserId),
                      inArray(assets.id, rowValue.assetIds),
                    ),
                  );
              }
            }

            for (const lane of result.reviewLanes) {
              await db
                .insert(workflowReviewLanes)
                .values({
                  attempt: lane.attempt,
                  createdAt: now,
                  id: randomUUID(),
                  laneIndex: lane.laneIndex,
                  nodeId: lane.nodeId,
                  ownerUserId: lane.ownerUserId,
                  projectId: lane.projectId,
                  runId: lane.runId,
                  status: lane.status,
                  updatedAt: now,
                  valueType: lane.valueType,
                })
                .onConflictDoUpdate({
                  target: [
                    workflowReviewLanes.runId,
                    workflowReviewLanes.nodeId,
                    workflowReviewLanes.laneIndex,
                    workflowReviewLanes.attempt,
                  ],
                  set: {
                    status: lane.status,
                    updatedAt: now,
                    valueType: lane.valueType,
                  },
                });
            }

            for (const output of result.outputs) {
              await db
                .delete(workflowArtifactLineage)
                .where(
                  and(
                    eq(workflowArtifactLineage.runId, output.runId),
                    eq(workflowArtifactLineage.dependentNodeId, output.nodeId),
                    eq(
                      workflowArtifactLineage.dependentLaneIndex,
                      output.laneIndex,
                    ),
                    eq(
                      workflowArtifactLineage.dependentAttempt,
                      output.attempt,
                    ),
                  ),
                );
            }

            for (const lineage of result.lineage) {
              await db
                .insert(workflowArtifactLineage)
                .values({
                  createdAt: now,
                  dependentAttempt: lineage.dependentAttempt,
                  dependentLaneIndex: lineage.dependentLaneIndex,
                  dependentNodeId: lineage.dependentNodeId,
                  id: randomUUID(),
                  runId: lineage.runId,
                  sourceAttempt: lineage.sourceAttempt,
                  sourceLaneIndex: lineage.sourceLaneIndex,
                  sourceNodeId: lineage.sourceNodeId,
                })
                .onConflictDoNothing({
                  target: [
                    workflowArtifactLineage.runId,
                    workflowArtifactLineage.sourceNodeId,
                    workflowArtifactLineage.sourceLaneIndex,
                    workflowArtifactLineage.sourceAttempt,
                    workflowArtifactLineage.dependentNodeId,
                    workflowArtifactLineage.dependentLaneIndex,
                    workflowArtifactLineage.dependentAttempt,
                  ],
                });
            }
          },
          catch: toArtifactStoreError,
        }),
    }),
  );
}
