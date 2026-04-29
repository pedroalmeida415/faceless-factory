import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
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
  getWorkflowOutputKey,
  type WorkflowOutputIdentity,
} from "~/lib/workflow/execution/output-dependencies";
import type { ReusableWorkflowOutputCandidate } from "~/lib/workflow/execution/output-result-reuse";
import type {
  NodeOutputArtifact,
  NodeOutputQuery,
  OutputExecutionResult,
  RegenerationAttemptRequest,
  WorkflowOutputArtifactStatus,
  WorkflowOutputArtifacts,
  WorkflowOutputErrorArtifact,
} from "~/lib/workflow/execution/types";
import type { RuntimeValue } from "~/lib/workflow/runtime-values";
import type {
  WorkflowAsset,
  WorkflowOutputReviewStatus,
} from "~/lib/workflow/types";
import { db } from "~/server/db";
import { assets, nodeExecutions, taskRuns } from "~/server/db/schema";

type AssetRow = typeof assets.$inferSelect;
type NodeExecutionRow = typeof nodeExecutions.$inferSelect;
type TaskRunRow = typeof taskRuns.$inferSelect;
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

function getOutputPersistenceKey(output: {
  projectId: string;
  nodeId: string;
  outputIndex: number;
}) {
  return `${output.projectId}:${output.nodeId}:${output.outputIndex}`;
}

function getNodeReviewStatus(
  node: GeneratorWorkflowNode,
  outputIndex: number,
  attempt: number,
) {
  return node.reviewEnabled
    ? (node.review.outputs.find(
        (output) =>
          output.outputIndex === outputIndex && output.attempt === attempt,
      )?.status ?? "pending")
    : null;
}

function toOutputArtifact(params: {
  outputIndex: number;
  documentRevision: number | null;
  node: GeneratorWorkflowNode;
  ownerUserId: string;
  projectId: string;
  executionId: string;
}) {
  const { node, outputIndex } = params;
  const attempt = getGeneratorOutputAttempt(node, outputIndex);
  const promptSnapshot = node.lastPrompt || null;
  const systemPromptSnapshot =
    node.kind === "llmGenerator" ? node.lastSystemPrompt || null : undefined;
  const inputHash = getGeneratorOutputInputHash({
    outputIndex,
    node,
    promptSnapshot,
    systemPromptSnapshot,
  });
  const value =
    node.kind === "llmGenerator"
      ? node.outputs[outputIndex]?.trim()
        ? ({
            type: "text",
            items: [node.outputs[outputIndex] ?? ""],
          } satisfies RuntimeValue)
        : null
      : (node.outputs[outputIndex]?.length ?? 0) > 0
        ? ({
            type: node.kind === "imageGenerator" ? "image" : "video",
            items: [node.outputs[outputIndex] ?? []],
          } satisfies RuntimeValue)
        : null;

  return value
    ? ({
        attempt,
        documentRevision: params.documentRevision,
        executionId: params.executionId,
        idempotencyKey: getGeneratorOutputIdempotencyKey({
          attempt,
          inputHash,
          outputIndex,
          node,
          executionId: params.executionId,
        }),
        inputHash,
        model: node.model,
        nodeId: node.id,
        outputIndex,
        ownerUserId: params.ownerUserId,
        projectId: params.projectId,
        promptSnapshot,
        reviewStatus: getNodeReviewStatus(node, outputIndex, attempt),
        value,
      } satisfies NodeOutputArtifact)
    : null;
}

export function buildOutputExecutionResultFromDocument(params: {
  costCredits: number;
  costCreditsByOutputKey?: ReadonlyMap<string, number>;
  document: WorkflowDocument;
  documentRevision: number | null;
  outputIndex: number | null;
  ownerUserId: string;
  projectId: string;
  executionId: string;
  status: WorkflowOutputArtifactStatus;
  targetNodeIds: readonly string[];
}) {
  const targetNodeIds = new Set(params.targetNodeIds);
  const outputs = params.document.nodes.flatMap((node) => {
    if (
      !targetNodeIds.has(node.id) ||
      (node.kind !== "imageGenerator" &&
        node.kind !== "videoGenerator" &&
        node.kind !== "llmGenerator")
    ) {
      return [];
    }
    return node.outputs.flatMap((_, outputIndex) => {
      if (params.outputIndex !== null && outputIndex !== params.outputIndex) {
        return [];
      }
      return (
        toOutputArtifact({
          documentRevision: params.documentRevision,
          executionId: params.executionId,
          node,
          outputIndex,
          ownerUserId: params.ownerUserId,
          projectId: params.projectId,
        }) ?? []
      );
    });
  });

  return {
    costCredits: params.costCredits,
    costCreditsByOutputKey: params.costCreditsByOutputKey,
    executionId: params.executionId,
    outputIndex: params.outputIndex,
    outputs,
    status: params.status,
  } satisfies OutputExecutionResult;
}

function outputToRowValue(output: NodeOutputArtifact) {
  return output.value.type === "text"
    ? {
        assetIds: [],
        textValue: output.value.items[0] ?? "",
        valueType: output.value.type,
      }
    : {
        assetIds: output.value.items[0]?.map((asset) => asset.id) ?? [],
        textValue: null,
        valueType: output.value.type,
      };
}

function rowToOutput(row: TaskRunRow, assetById: Map<string, WorkflowAsset>) {
  if (
    (row.status !== "success" && row.status !== "waiting_for_review") ||
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
        ? ({ type: "text", items: [row.textValue] } satisfies RuntimeValue)
        : null
      : row.assetIds.length > 0 && resolvedAssets.length === row.assetIds.length
        ? ({
            type: row.valueType,
            items: [resolvedAssets],
          } satisfies RuntimeValue)
        : null;

  return value
    ? ({
        attempt: row.version,
        documentRevision: row.documentRevision,
        executionId: row.executionId,
        idempotencyKey: row.idempotencyKey,
        inputHash: row.inputHash,
        model: row.model,
        nodeId: row.nodeId,
        outputIndex: row.outputIndex,
        ownerUserId: row.ownerUserId,
        projectId: row.workflowId,
        promptSnapshot: row.promptSnapshot,
        reviewStatus: row.reviewStatus,
        value,
      } satisfies NodeOutputArtifact)
    : null;
}

function rowToOutputResult(
  row: TaskRunRow,
  assetById: Map<string, WorkflowAsset>,
) {
  if (row.status === "success" || row.status === "waiting_for_review") {
    const output = rowToOutput(row, assetById);
    return output ? { ...output, status: row.status } : null;
  }

  if (row.status !== "error") {
    return null;
  }

  return {
    attempt: row.version,
    error: row.error ?? "Workflow execution output failed.",
    executionId: row.executionId,
    failedAt: (row.failedAt ?? row.updatedAt).toISOString(),
    nodeId: row.nodeId,
    outputIndex: row.outputIndex,
    ownerUserId: row.ownerUserId,
    projectId: row.workflowId,
    status: "error" as const,
  } satisfies WorkflowOutputErrorArtifact & { status: "error" };
}

function compareNodeExecution(left: NodeExecutionRow, right: NodeExecutionRow) {
  return (
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id)
  );
}

function latestNodeExecutions(rows: readonly NodeExecutionRow[]) {
  const latest = new Map<string, NodeExecutionRow>();
  for (const row of rows) {
    const existing = latest.get(row.nodeId);
    if (!existing || compareNodeExecution(existing, row) < 0) {
      latest.set(row.nodeId, row);
    }
  }
  return latest;
}

function latestTaskVersions(rows: readonly TaskRunRow[]) {
  const latest = new Map<string, TaskRunRow>();
  for (const row of rows) {
    const key = `${row.nodeExecutionId}:${row.outputIndex}`;
    const existing = latest.get(key);
    if (!existing || existing.version < row.version) {
      latest.set(key, row);
    }
  }
  return Array.from(latest.values());
}

async function loadAssetsForRows(
  ownerUserId: string,
  rows: readonly TaskRunRow[],
) {
  const assetIds = Array.from(new Set(rows.flatMap((row) => row.assetIds)));
  const assetRows = assetIds.length
    ? await db
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.ownerUserId, ownerUserId),
            inArray(assets.id, assetIds),
          ),
        )
    : [];
  return new Map(assetRows.map((row) => [row.id, toWorkflowAsset(row)]));
}

async function getCurrentTaskRows(params: {
  ownerUserId: string;
  workflowId: string;
  excludeExecutionId?: string | null;
}) {
  const executionRows = await db
    .select()
    .from(nodeExecutions)
    .where(
      and(
        eq(nodeExecutions.ownerUserId, params.ownerUserId),
        eq(nodeExecutions.workflowId, params.workflowId),
      ),
    );
  const latestExecutionIds = new Set(
    Array.from(latestNodeExecutions(executionRows).values()).map(
      (row) => row.id,
    ),
  );
  if (!latestExecutionIds.size) {
    return [];
  }
  const rows = await db
    .select()
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.ownerUserId, params.ownerUserId),
        eq(taskRuns.workflowId, params.workflowId),
        inArray(taskRuns.nodeExecutionId, Array.from(latestExecutionIds)),
      ),
    );
  return latestTaskVersions(
    params.excludeExecutionId
      ? rows.filter((row) => row.executionId !== params.excludeExecutionId)
      : rows,
  );
}

async function ensureNodeExecution(params: {
  documentRevision: number | null;
  executionId: string;
  nodeId: string;
  outputCount: number;
  ownerUserId: string;
  workflowId: string;
}) {
  const [existing] = await db
    .select()
    .from(nodeExecutions)
    .where(
      and(
        eq(nodeExecutions.ownerUserId, params.ownerUserId),
        eq(nodeExecutions.workflowId, params.workflowId),
        eq(nodeExecutions.executionId, params.executionId),
        eq(nodeExecutions.nodeId, params.nodeId),
      ),
    )
    .orderBy(desc(nodeExecutions.createdAt), desc(nodeExecutions.id))
    .limit(1);

  if (existing) {
    return existing;
  }

  const now = new Date();
  const [created] = await db
    .insert(nodeExecutions)
    .values({
      createdAt: now,
      dispatchedAt: now,
      documentRevision: params.documentRevision,
      executionId: params.executionId,
      id: randomUUID(),
      nodeId: params.nodeId,
      outputCount: params.outputCount,
      ownerUserId: params.ownerUserId,
      status: "dispatched",
      targetReason: "node_run",
      updatedAt: now,
      workflowId: params.workflowId,
    })
    .returning();

  if (!created) {
    throw new WorkflowInfrastructureError({
      message: "Failed to create node execution.",
    });
  }
  return created;
}

function getOutputCount(outputs: readonly { outputIndex: number }[]) {
  return Math.max(1, ...outputs.map((output) => output.outputIndex + 1));
}

function getOutputArtifactsEffect(params: {
  ownerUserId: string;
  executionId: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      const rows = latestTaskVersions(
        await db
          .select()
          .from(taskRuns)
          .where(
            and(
              eq(taskRuns.executionId, params.executionId),
              eq(taskRuns.ownerUserId, params.ownerUserId),
            ),
          ),
      );
      const assetById = await loadAssetsForRows(params.ownerUserId, rows);
      return {
        outputResults: rows.flatMap(
          (row) => rowToOutputResult(row, assetById) ?? [],
        ),
      } satisfies WorkflowOutputArtifacts;
    },
    catch: toArtifactStoreError,
  });
}

function getProjectArtifactsEffect(params: {
  ownerUserId: string;
  projectId: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      const rows = await getCurrentTaskRows({
        ownerUserId: params.ownerUserId,
        workflowId: params.projectId,
      });
      const assetById = await loadAssetsForRows(params.ownerUserId, rows);
      return {
        outputResults: rows.flatMap(
          (row) => rowToOutputResult(row, assetById) ?? [],
        ),
      } satisfies WorkflowOutputArtifacts;
    },
    catch: toArtifactStoreError,
  });
}

function getNodeOutputEffect(params: NodeOutputQuery) {
  return Effect.tryPromise({
    try: async () => {
      const [row] = await db
        .select()
        .from(taskRuns)
        .where(
          and(
            eq(taskRuns.ownerUserId, params.ownerUserId),
            eq(taskRuns.nodeId, params.nodeId),
            eq(taskRuns.outputIndex, params.outputIndex),
            eq(taskRuns.version, params.attempt),
            eq(taskRuns.status, "success"),
            eq(taskRuns.inputHash, params.inputHash),
            params.projectId
              ? eq(taskRuns.workflowId, params.projectId)
              : eq(taskRuns.executionId, params.executionId),
          ),
        )
        .limit(1);
      if (!row) {
        return null;
      }
      const assetById = await loadAssetsForRows(params.ownerUserId, [row]);
      return rowToOutput(row, assetById);
    },
    catch: toArtifactStoreError,
  });
}

function getProjectOutputReuseCandidatesEffect(params: {
  excludeExecutionId?: string | null;
  items: readonly WorkflowOutputIdentity[];
  ownerUserId: string;
  projectId: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      const outputKeys = new Set(params.items.map(getWorkflowOutputKey));
      if (!outputKeys.size) {
        return [];
      }
      const rows = (
        await getCurrentTaskRows({
          excludeExecutionId: params.excludeExecutionId,
          ownerUserId: params.ownerUserId,
          workflowId: params.projectId,
        })
      ).filter((row) => outputKeys.has(getWorkflowOutputKey(row)));
      const assetById = await loadAssetsForRows(params.ownerUserId, rows);
      return rows.flatMap((row) => {
        const result = rowToOutputResult(row, assetById);
        return result
          ? [
              {
                ...result,
                updatedAt: row.updatedAt.toISOString(),
              } satisfies ReusableWorkflowOutputCandidate,
            ]
          : [];
      });
    },
    catch: toArtifactStoreError,
  });
}

function copyReusableOutputsEffect(params: {
  outputs: readonly NodeOutputArtifact[];
  ownerUserId: string;
  projectId: string;
  executionId: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      const now = new Date();
      for (const output of params.outputs) {
        const rowValue = outputToRowValue(output);
        const nodeExecution = await ensureNodeExecution({
          documentRevision: output.documentRevision,
          executionId: params.executionId,
          nodeId: output.nodeId,
          outputCount: output.outputIndex + 1,
          ownerUserId: params.ownerUserId,
          workflowId: params.projectId,
        });
        const id = randomUUID();
        await db
          .insert(taskRuns)
          .values({
            ...rowValue,
            costCredits: 0,
            createdAt: now,
            documentRevision: output.documentRevision,
            error: null,
            executionId: params.executionId,
            failedAt: null,
            finishedAt: now,
            id,
            idempotencyKey: `reused:${params.executionId}:${output.nodeId}:${output.outputIndex}:${output.idempotencyKey}:${output.attempt}`,
            inputHash: output.inputHash,
            jobId: id,
            model: output.model,
            nodeExecutionId: nodeExecution.id,
            nodeId: output.nodeId,
            outputIndex: output.outputIndex,
            ownerUserId: params.ownerUserId,
            promptSnapshot: output.promptSnapshot,
            queuedAt: now,
            reviewStatus: output.reviewStatus,
            startedAt: now,
            status: "success",
            targetReason: "dependency_run",
            updatedAt: now,
            version: 0,
            workflowId: params.projectId,
          })
          .onConflictDoNothing();
      }
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
    readonly getOutputArtifacts: (params: {
      ownerUserId: string;
      executionId: string;
    }) => Effect.Effect<WorkflowOutputArtifacts, ArtifactStoreError>;
    readonly getProjectArtifacts: (params: {
      ownerUserId: string;
      projectId: string;
    }) => Effect.Effect<WorkflowOutputArtifacts, ArtifactStoreError>;
    readonly getProjectOutputReuseCandidates: (params: {
      excludeExecutionId?: string | null;
      items: readonly WorkflowOutputIdentity[];
      ownerUserId: string;
      projectId: string;
    }) => Effect.Effect<ReusableWorkflowOutputCandidate[], ArtifactStoreError>;
    readonly copyReusableOutputs: (params: {
      outputs: readonly NodeOutputArtifact[];
      ownerUserId: string;
      projectId: string;
      executionId: string;
    }) => Effect.Effect<number, ArtifactStoreError>;
    readonly getActiveOutputKeys: (params: {
      executionId: string;
    }) => Effect.Effect<string[], ArtifactStoreError>;
    readonly getNodeOutput: (
      params: NodeOutputQuery,
    ) => Effect.Effect<NodeOutputArtifact | null, ArtifactStoreError>;
    readonly setReviewOutputStatus: (params: {
      attempt?: number | null;
      outputIndex: number;
      nodeId: string;
      ownerUserId: string;
      projectId?: string | null;
      executionId: string;
      status: WorkflowOutputReviewStatus;
    }) => Effect.Effect<void, ArtifactStoreError>;
    readonly upsertOutputError: (
      params: WorkflowOutputErrorArtifact,
    ) => Effect.Effect<void, ArtifactStoreError>;
    readonly upsertOutputExecutionResult: (
      result: OutputExecutionResult,
    ) => Effect.Effect<void, ArtifactStoreError>;
  }
>() {
  static readonly Live = Layer.succeed(
    this,
    WorkflowArtifactStore.of({
      createNextAttempt: (params) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select()
              .from(taskRuns)
              .where(
                and(
                  eq(taskRuns.ownerUserId, params.ownerUserId),
                  eq(taskRuns.nodeId, params.nodeId),
                  eq(taskRuns.outputIndex, params.outputIndex),
                  params.projectId
                    ? eq(taskRuns.workflowId, params.projectId)
                    : eq(taskRuns.executionId, params.executionId),
                ),
              );
            const latestVersion = Math.max(
              -1,
              ...rows.map((row) => row.version),
            );
            const latest = rows.find((row) => row.version === latestVersion);
            if (latest?.reviewStatus) {
              await db
                .update(taskRuns)
                .set({ reviewStatus: "regenerating", updatedAt: new Date() })
                .where(eq(taskRuns.id, latest.id));
            }
            return latestVersion + 1;
          },
          catch: toArtifactStoreError,
        }),
      copyReusableOutputs: copyReusableOutputsEffect,
      getActiveOutputKeys: (params) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select({
                nodeId: taskRuns.nodeId,
                outputIndex: taskRuns.outputIndex,
              })
              .from(taskRuns)
              .where(
                and(
                  eq(taskRuns.executionId, params.executionId),
                  inArray(taskRuns.status, [
                    "queued",
                    "running",
                    "waiting_for_review",
                  ]),
                ),
              );
            return rows.map(getWorkflowOutputKey);
          },
          catch: toArtifactStoreError,
        }),
      getNodeOutput: getNodeOutputEffect,
      getOutputArtifacts: getOutputArtifactsEffect,
      getProjectArtifacts: getProjectArtifactsEffect,
      getProjectOutputReuseCandidates: getProjectOutputReuseCandidatesEffect,
      setReviewOutputStatus: (params) =>
        Effect.gen(function* () {
          const rows = yield* Effect.tryPromise({
            try: () =>
              db
                .select()
                .from(taskRuns)
                .where(
                  and(
                    eq(taskRuns.ownerUserId, params.ownerUserId),
                    eq(taskRuns.nodeId, params.nodeId),
                    eq(taskRuns.outputIndex, params.outputIndex),
                    isNotNull(taskRuns.reviewStatus),
                    params.projectId
                      ? eq(taskRuns.workflowId, params.projectId)
                      : eq(taskRuns.executionId, params.executionId),
                  ),
                ),
            catch: toArtifactStoreError,
          });
          const attempt =
            params.attempt ?? Math.max(-1, ...rows.map((row) => row.version));
          const row = rows.find((candidate) => candidate.version === attempt);
          if (!row) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: `Review output ${params.outputIndex + 1} does not exist.`,
              }),
            );
          }
          yield* Effect.tryPromise({
            try: () =>
              db
                .update(taskRuns)
                .set({
                  reviewStatus: params.status,
                  status: params.status === "approved" ? "success" : row.status,
                  updatedAt: new Date(),
                })
                .where(eq(taskRuns.id, row.id)),
            catch: toArtifactStoreError,
          });
        }),
      upsertOutputError: (params) =>
        Effect.tryPromise({
          try: async () => {
            const failedAt = new Date(params.failedAt);
            const nodeExecution = await ensureNodeExecution({
              documentRevision: null,
              executionId: params.executionId,
              nodeId: params.nodeId,
              outputCount: params.outputIndex + 1,
              ownerUserId: params.ownerUserId,
              workflowId: params.projectId,
            });
            const id = randomUUID();
            await db
              .insert(taskRuns)
              .values({
                assetIds: [],
                costCredits: 0,
                createdAt: failedAt,
                error: params.error,
                executionId: params.executionId,
                failedAt,
                finishedAt: failedAt,
                id,
                jobId: id,
                nodeExecutionId: nodeExecution.id,
                nodeId: params.nodeId,
                outputIndex: params.outputIndex,
                ownerUserId: params.ownerUserId,
                queuedAt: failedAt,
                startedAt: failedAt,
                status: "error",
                targetReason: "node_run",
                updatedAt: failedAt,
                version: params.attempt,
                workflowId: params.projectId,
              })
              .onConflictDoUpdate({
                target: [
                  taskRuns.nodeExecutionId,
                  taskRuns.outputIndex,
                  taskRuns.version,
                ],
                set: {
                  assetIds: [],
                  error: params.error,
                  failedAt,
                  finishedAt: failedAt,
                  status: "error",
                  textValue: null,
                  updatedAt: failedAt,
                  valueType: null,
                },
              });
          },
          catch: toArtifactStoreError,
        }),
      upsertOutputExecutionResult: (result) =>
        Effect.tryPromise({
          try: async () => {
            const now = new Date();
            const outputCount = getOutputCount(result.outputs);
            for (const output of result.outputs) {
              const rowValue = outputToRowValue(output);
              const nodeExecution = await ensureNodeExecution({
                documentRevision: output.documentRevision,
                executionId: output.executionId,
                nodeId: output.nodeId,
                outputCount,
                ownerUserId: output.ownerUserId,
                workflowId: output.projectId,
              });
              const costCredits =
                result.costCreditsByOutputKey?.get(
                  getOutputPersistenceKey(output),
                ) ??
                (result.outputIndex === null
                  ? output === result.outputs[0]
                    ? result.costCredits
                    : 0
                  : output.outputIndex === result.outputIndex
                    ? result.costCredits
                    : 0);
              const id = randomUUID();
              await db
                .insert(taskRuns)
                .values({
                  ...rowValue,
                  costCredits,
                  createdAt: now,
                  documentRevision: output.documentRevision,
                  error: null,
                  executionId: output.executionId,
                  failedAt: null,
                  finishedAt: now,
                  id,
                  idempotencyKey: output.idempotencyKey,
                  inputHash: output.inputHash,
                  jobId: id,
                  model: output.model,
                  nodeExecutionId: nodeExecution.id,
                  nodeId: output.nodeId,
                  outputIndex: output.outputIndex,
                  ownerUserId: output.ownerUserId,
                  promptSnapshot: output.promptSnapshot,
                  queuedAt: now,
                  reviewStatus: output.reviewStatus,
                  startedAt: now,
                  status:
                    output.reviewStatus && output.reviewStatus !== "approved"
                      ? "waiting_for_review"
                      : "success",
                  targetReason: "node_run",
                  updatedAt: now,
                  version: output.attempt,
                  workflowId: output.projectId,
                })
                .onConflictDoUpdate({
                  target: [
                    taskRuns.nodeExecutionId,
                    taskRuns.outputIndex,
                    taskRuns.version,
                  ],
                  set: {
                    ...rowValue,
                    costCredits,
                    documentRevision: output.documentRevision,
                    error: null,
                    failedAt: null,
                    finishedAt: now,
                    idempotencyKey: output.idempotencyKey,
                    inputHash: output.inputHash,
                    model: output.model,
                    promptSnapshot: output.promptSnapshot,
                    reviewStatus: output.reviewStatus,
                    status:
                      output.reviewStatus && output.reviewStatus !== "approved"
                        ? "waiting_for_review"
                        : "success",
                    updatedAt: now,
                    valueType: rowValue.valueType,
                  },
                });
            }
          },
          catch: toArtifactStoreError,
        }),
    }),
  );
}
