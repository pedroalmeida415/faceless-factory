import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
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
import {
  getWorkflowLaneKey,
  type WorkflowLaneIdentity,
} from "~/lib/workflow/execution/lane-dependencies";
import type { ReusableWorkflowLaneCandidate } from "~/lib/workflow/execution/lane-result-reuse";
import type {
  LaneExecutionResult,
  NodeLaneOutputArtifact,
  NodeLaneOutputQuery,
  RegenerationAttemptRequest,
  WorkflowLaneErrorArtifact,
  WorkflowRunArtifactStatus,
  WorkflowRunArtifacts,
} from "~/lib/workflow/execution/types";
import type { RuntimeValue } from "~/lib/workflow/lanes";
import type {
  WorkflowAsset,
  WorkflowReviewLaneStatus,
} from "~/lib/workflow/types";
import { db } from "~/server/db";
import { assets, workflowLaneResults, workflowRuns } from "~/server/db/schema";

type LaneResultRow = typeof workflowLaneResults.$inferSelect;
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
      reviewStatus: getNodeReviewStatus(node, laneIndex, attempt),
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
    reviewStatus: getNodeReviewStatus(node, laneIndex, attempt),
    runId: params.runId,
    value,
  } satisfies NodeLaneOutputArtifact;
}

function getNodeReviewStatus(
  node: GeneratorWorkflowNode,
  laneIndex: number,
  attempt: number,
) {
  return node.reviewEnabled
    ? (node.review.lanes.find(
        (lane) => lane.laneIndex === laneIndex && lane.attempt === attempt,
      )?.status ?? "pending")
    : null;
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
  const outputs: NodeLaneOutputArtifact[] = [];

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
      }
    }
  }

  return {
    costCredits: params.costCredits,
    laneIndex: params.laneIndex,
    outputs,
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

function rowToOutput(
  row: LaneResultRow,
  assetById: Map<string, WorkflowAsset>,
) {
  if (
    row.status !== "success" ||
    !row.valueType ||
    !row.inputHash ||
    !row.idempotencyKey
  ) {
    return null;
  }

  const resolvedAssets = row.assetIds.flatMap(
    (assetId) => assetById.get(assetId) ?? [],
  );
  const value =
    row.valueType === "text"
      ? row.textValue?.trim()
        ? ({ type: "text", lanes: [row.textValue] } satisfies RuntimeValue)
        : null
      : row.assetIds.length > 0 && resolvedAssets.length === row.assetIds.length
        ? ({
            type: row.valueType,
            lanes: [resolvedAssets],
          } satisfies RuntimeValue)
        : null;

  if (!value) {
    return null;
  }

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
    reviewStatus: row.reviewStatus,
    runId: row.runId,
    value,
  } satisfies NodeLaneOutputArtifact;
}

function rowToLaneResult(
  row: LaneResultRow,
  assetById: Map<string, WorkflowAsset>,
) {
  if (row.status === "success") {
    const output = rowToOutput(row, assetById);
    return output ? { ...output, status: "success" as const } : null;
  }

  return {
    attempt: row.attempt,
    error: row.error ?? "Workflow execution lane failed.",
    failedAt: (row.failedAt ?? row.updatedAt).toISOString(),
    laneIndex: row.laneIndex,
    nodeId: row.nodeId,
    ownerUserId: row.ownerUserId,
    projectId: row.projectId,
    runId: row.runId,
    status: "error" as const,
  } satisfies WorkflowLaneErrorArtifact & { status: "error" };
}

function getRunArtifactsEffect(params: { ownerUserId: string; runId: string }) {
  return Effect.tryPromise({
    try: async () => {
      const resultRows = await db
        .select()
        .from(workflowLaneResults)
        .where(
          and(
            eq(workflowLaneResults.runId, params.runId),
            eq(workflowLaneResults.ownerUserId, params.ownerUserId),
          ),
        );
      const assetIds = Array.from(
        new Set(resultRows.flatMap((row) => row.assetIds)),
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
        laneResults: resultRows.flatMap((row) => {
          const result = rowToLaneResult(row, assetById);
          return result ? [result] : [];
        }),
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
        .from(workflowLaneResults)
        .where(
          and(
            eq(workflowLaneResults.runId, params.runId),
            eq(workflowLaneResults.ownerUserId, params.ownerUserId),
            eq(workflowLaneResults.nodeId, params.nodeId),
            eq(workflowLaneResults.laneIndex, params.laneIndex),
            eq(workflowLaneResults.attempt, params.attempt),
            eq(workflowLaneResults.status, "success"),
            eq(workflowLaneResults.inputHash, params.inputHash),
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

function getProjectLaneReuseCandidatesEffect(params: {
  excludeRunId?: string | null;
  lanes: readonly WorkflowLaneIdentity[];
  ownerUserId: string;
  projectId: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      const laneKeys = new Set(params.lanes.map(getWorkflowLaneKey));
      if (!laneKeys.size) {
        return [];
      }

      const rows = await db
        .select({ laneResult: workflowLaneResults })
        .from(workflowLaneResults)
        .innerJoin(workflowRuns, eq(workflowRuns.id, workflowLaneResults.runId))
        .where(
          and(
            eq(workflowLaneResults.ownerUserId, params.ownerUserId),
            eq(workflowLaneResults.projectId, params.projectId),
            inArray(workflowRuns.status, ["success", "error"]),
            params.excludeRunId
              ? ne(workflowLaneResults.runId, params.excludeRunId)
              : undefined,
            inArray(
              workflowLaneResults.nodeId,
              Array.from(new Set(params.lanes.map((lane) => lane.nodeId))),
            ),
          ),
        )
        .then((rows) => rows.map((row) => row.laneResult));
      const candidateRows = rows.filter((row) =>
        laneKeys.has(getWorkflowLaneKey(row)),
      );
      const assetIds = Array.from(
        new Set(candidateRows.flatMap((row) => row.assetIds)),
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

      return candidateRows.flatMap((row) => {
        const result = rowToLaneResult(row, assetById);
        return result
          ? [
              {
                ...result,
                updatedAt: row.updatedAt.toISOString(),
              } satisfies ReusableWorkflowLaneCandidate,
            ]
          : [];
      });
    },
    catch: toArtifactStoreError,
  });
}

function copyReusableLaneOutputsEffect(params: {
  outputs: readonly NodeLaneOutputArtifact[];
  ownerUserId: string;
  projectId: string;
  runId: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      const now = new Date();
      await db.transaction(async (tx) => {
        for (const output of params.outputs) {
          const rowValue = outputToRowValue(output);
          await tx
            .insert(workflowLaneResults)
            .values({
              ...rowValue,
              attempt: 0,
              createdAt: now,
              error: null,
              failedAt: null,
              id: randomUUID(),
              idempotencyKey: `reused:${params.runId}:${output.nodeId}:${output.laneIndex}:0:${output.runId}:${output.attempt}`,
              inputHash: output.inputHash,
              laneIndex: output.laneIndex,
              model: output.model,
              nodeId: output.nodeId,
              ownerUserId: params.ownerUserId,
              projectId: params.projectId,
              promptSnapshot: output.promptSnapshot,
              reviewStatus: output.reviewStatus,
              runId: params.runId,
              status: "success",
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [
                workflowLaneResults.runId,
                workflowLaneResults.nodeId,
                workflowLaneResults.laneIndex,
                workflowLaneResults.attempt,
              ],
              set: {
                assetIds: rowValue.assetIds,
                error: null,
                failedAt: null,
                idempotencyKey: `reused:${params.runId}:${output.nodeId}:${output.laneIndex}:0:${output.runId}:${output.attempt}`,
                inputHash: output.inputHash,
                model: output.model,
                promptSnapshot: output.promptSnapshot,
                reviewStatus: output.reviewStatus,
                status: "success",
                textValue: rowValue.textValue,
                updatedAt: now,
                valueType: rowValue.valueType,
              },
            });
        }
      });

      return params.outputs.length;
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
    readonly getProjectLaneReuseCandidates: (params: {
      excludeRunId?: string | null;
      lanes: readonly WorkflowLaneIdentity[];
      ownerUserId: string;
      projectId: string;
    }) => Effect.Effect<ReusableWorkflowLaneCandidate[], ArtifactStoreError>;
    readonly copyReusableLaneOutputs: (params: {
      outputs: readonly NodeLaneOutputArtifact[];
      ownerUserId: string;
      projectId: string;
      runId: string;
    }) => Effect.Effect<number, ArtifactStoreError>;
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
    readonly upsertLaneError: (
      params: WorkflowLaneErrorArtifact,
    ) => Effect.Effect<void, ArtifactStoreError>;
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
            const outputRows = await db
              .select({ attempt: workflowLaneResults.attempt })
              .from(workflowLaneResults)
              .where(
                and(
                  eq(workflowLaneResults.runId, params.runId),
                  eq(workflowLaneResults.ownerUserId, params.ownerUserId),
                  eq(workflowLaneResults.nodeId, params.nodeId),
                  eq(workflowLaneResults.laneIndex, params.laneIndex),
                ),
              );
            const latestAttempt = Math.max(
              -1,
              ...outputRows.map((row) => row.attempt),
            );
            if (latestAttempt >= 0) {
              await db
                .update(workflowLaneResults)
                .set({ reviewStatus: "regenerating", updatedAt: new Date() })
                .where(
                  and(
                    eq(workflowLaneResults.runId, params.runId),
                    eq(workflowLaneResults.ownerUserId, params.ownerUserId),
                    eq(workflowLaneResults.nodeId, params.nodeId),
                    eq(workflowLaneResults.laneIndex, params.laneIndex),
                    eq(workflowLaneResults.attempt, latestAttempt),
                    isNotNull(workflowLaneResults.reviewStatus),
                  ),
                );
            }
            return latestAttempt + 1;
          },
          catch: toArtifactStoreError,
        }),
      getRunArtifacts: getRunArtifactsEffect,
      getProjectLaneReuseCandidates: getProjectLaneReuseCandidatesEffect,
      copyReusableLaneOutputs: copyReusableLaneOutputsEffect,
      getNodeLaneOutput: getNodeLaneOutputEffect,
      setReviewLaneStatus: (params) =>
        Effect.gen(function* () {
          const rows = yield* Effect.tryPromise({
            try: () =>
              db
                .select({ attempt: workflowLaneResults.attempt })
                .from(workflowLaneResults)
                .where(
                  and(
                    eq(workflowLaneResults.runId, params.runId),
                    eq(workflowLaneResults.ownerUserId, params.ownerUserId),
                    eq(workflowLaneResults.nodeId, params.nodeId),
                    eq(workflowLaneResults.laneIndex, params.laneIndex),
                    isNotNull(workflowLaneResults.reviewStatus),
                  ),
                ),
            catch: toArtifactStoreError,
          });
          const attempt =
            params.attempt ?? Math.max(-1, ...rows.map((row) => row.attempt));
          if (attempt < 0) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: `Review lane ${params.laneIndex + 1} does not exist.`,
              }),
            );
          }
          yield* Effect.tryPromise({
            try: () =>
              db
                .update(workflowLaneResults)
                .set({ reviewStatus: params.status, updatedAt: new Date() })
                .where(
                  and(
                    eq(workflowLaneResults.runId, params.runId),
                    eq(workflowLaneResults.ownerUserId, params.ownerUserId),
                    eq(workflowLaneResults.nodeId, params.nodeId),
                    eq(workflowLaneResults.laneIndex, params.laneIndex),
                    eq(workflowLaneResults.attempt, attempt),
                    isNotNull(workflowLaneResults.reviewStatus),
                  ),
                ),
            catch: toArtifactStoreError,
          });
        }),
      upsertLaneError: (params) =>
        Effect.tryPromise({
          try: async () => {
            const failedAt = new Date(params.failedAt);
            await db
              .insert(workflowLaneResults)
              .values({
                assetIds: [],
                attempt: params.attempt,
                error: params.error,
                failedAt,
                reviewStatus: null,
                id: randomUUID(),
                laneIndex: params.laneIndex,
                nodeId: params.nodeId,
                ownerUserId: params.ownerUserId,
                projectId: params.projectId,
                runId: params.runId,
                status: "error",
                updatedAt: failedAt,
              })
              .onConflictDoUpdate({
                target: [
                  workflowLaneResults.runId,
                  workflowLaneResults.nodeId,
                  workflowLaneResults.laneIndex,
                  workflowLaneResults.attempt,
                ],
                set: {
                  assetIds: [],
                  error: params.error,
                  failedAt,
                  idempotencyKey: null,
                  inputHash: null,
                  model: null,
                  promptSnapshot: null,
                  reviewStatus: null,
                  status: "error",
                  textValue: null,
                  updatedAt: failedAt,
                  valueType: null,
                },
              });
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
                .insert(workflowLaneResults)
                .values({
                  ...rowValue,
                  attempt: output.attempt,
                  createdAt: now,
                  error: null,
                  failedAt: null,
                  id: randomUUID(),
                  idempotencyKey: output.idempotencyKey,
                  inputHash: output.inputHash,
                  laneIndex: output.laneIndex,
                  model: output.model,
                  nodeId: output.nodeId,
                  ownerUserId: output.ownerUserId,
                  projectId: output.projectId,
                  promptSnapshot: output.promptSnapshot,
                  reviewStatus: output.reviewStatus,
                  runId: output.runId,
                  status: "success",
                  updatedAt: now,
                })
                .onConflictDoUpdate({
                  target: [
                    workflowLaneResults.runId,
                    workflowLaneResults.nodeId,
                    workflowLaneResults.laneIndex,
                    workflowLaneResults.attempt,
                  ],
                  set: {
                    assetIds: rowValue.assetIds,
                    error: null,
                    failedAt: null,
                    idempotencyKey: output.idempotencyKey,
                    inputHash: output.inputHash,
                    model: output.model,
                    promptSnapshot: output.promptSnapshot,
                    reviewStatus: output.reviewStatus,
                    status: "success",
                    textValue: rowValue.textValue,
                    updatedAt: now,
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
          },
          catch: toArtifactStoreError,
        }),
    }),
  );
}
