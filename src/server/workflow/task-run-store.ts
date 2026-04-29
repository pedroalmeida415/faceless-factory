import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import { Effect } from "effect";
import {
  getErrorMessage,
  WorkflowInfrastructureError,
} from "~/lib/workflow/errors";
import { getGeneratorOutputAttempt } from "~/lib/workflow/execution/artifact-identity";
import {
  buildWorkflowOutputProjection,
  getWorkflowVisibleCompletionOutputs,
} from "~/lib/workflow/execution/artifact-projection";
import {
  getWorkflowOutputKey,
  type WorkflowPlannedOutputJob,
} from "~/lib/workflow/execution/output-dependencies";
import type {
  StartWorkflowExecutionRequest,
  TaskRunExecutionDocumentSnapshot,
  WorkflowOutputArtifacts,
} from "~/lib/workflow/execution/types";
import type { RuntimeValue } from "~/lib/workflow/runtime-values";
import { db } from "~/server/db";
import { nodeExecutions, taskRuns } from "~/server/db/schema";

type TaskRunRow = typeof taskRuns.$inferSelect;

function toTaskStoreError(cause: unknown) {
  return cause instanceof WorkflowInfrastructureError
    ? cause
    : new WorkflowInfrastructureError({
        message: getErrorMessage(cause),
        cause,
      });
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

  if (existing) return existing;

  const now = new Date();
  const [created] = await db
    .insert(nodeExecutions)
    .values({
      createdAt: now,
      dispatchedAt: null,
      documentRevision: params.documentRevision,
      executionId: params.executionId,
      id: randomUUID(),
      nodeId: params.nodeId,
      outputCount: params.outputCount,
      ownerUserId: params.ownerUserId,
      status: "pending",
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

function buildTaskRunExecutionDocumentSnapshot(params: {
  artifacts: WorkflowOutputArtifacts;
  executionId: string;
  job: WorkflowPlannedOutputJob;
  outputCount: number;
  projectId: string;
  request: StartWorkflowExecutionRequest;
  taskRunId: string;
}) {
  const dependencyKeys = new Set(
    params.job.dependencies.map(getWorkflowOutputKey),
  );
  const resolvedUpstreamOutputs = getWorkflowVisibleCompletionOutputs(
    params.artifacts,
  ).filter((output) => dependencyKeys.has(getWorkflowOutputKey(output)));

  return {
    type: "workflow-task-run-execution-document-snapshot",
    version: 1,
    projectId: params.projectId,
    executionId: params.executionId,
    jobId: params.taskRunId,
    taskRunId: params.taskRunId,
    targetNodeId: params.job.nodeId,
    outputIndex: params.job.outputIndex,
    outputCount: params.outputCount,
    documentRevision: params.request.documentRevision ?? null,
    document: buildWorkflowOutputProjection({
      artifacts: params.artifacts,
      document: params.request.document,
    }),
    resolvedUpstreamOutputs,
    requestContext: {
      accruedCostCredits: params.request.accruedCostCredits ?? null,
      clientExecutionId: params.request.clientExecutionId ?? null,
      documentRevision: params.request.documentRevision ?? null,
      idempotencyKey: params.request.idempotencyKey ?? null,
      projectId: params.projectId,
      selection: params.request.selection ?? null,
      target: params.request.target,
    },
  } satisfies TaskRunExecutionDocumentSnapshot;
}

export function toTaskRunExecutionRequest(
  snapshot: TaskRunExecutionDocumentSnapshot,
): StartWorkflowExecutionRequest {
  return {
    ...snapshot.requestContext,
    document: snapshot.document,
    documentRevision: snapshot.documentRevision,
    executionOutputFilter: {
      outputCount: snapshot.outputCount,
      outputIndex: snapshot.outputIndex,
    },
    reviewOutputFilter: null,
    selection: { nodeIds: [snapshot.targetNodeId] },
    target: { type: "selected-or-all" },
  };
}

export function getTaskRunSnapshotOutputValue(
  snapshot: TaskRunExecutionDocumentSnapshot,
  query: { nodeId: string; outputIndex: number },
): RuntimeValue | null {
  return (
    snapshot.resolvedUpstreamOutputs.find(
      (output) =>
        output.nodeId === query.nodeId &&
        output.outputIndex === query.outputIndex,
    )?.value ?? null
  );
}

export function createQueuedWorkflowTaskRuns(params: {
  artifacts: WorkflowOutputArtifacts;
  executionId: string;
  jobs: readonly WorkflowPlannedOutputJob[];
  outputCount: number;
  ownerUserId: string;
  projectId: string;
  request: StartWorkflowExecutionRequest;
  versionOverride?: number | null;
}) {
  return Effect.tryPromise({
    try: async () => {
      const now = new Date();
      const createdTasks: {
        executionId: string;
        jobId: string;
        taskRunId: string;
        userId: string;
      }[] = [];

      for (const job of params.jobs) {
        const node = params.request.document.nodes.find(
          (candidate) => candidate.id === job.nodeId,
        );
        if (
          !node ||
          (node.kind !== "imageGenerator" &&
            node.kind !== "videoGenerator" &&
            node.kind !== "llmGenerator")
        )
          continue;

        const nodeExecution = await ensureNodeExecution({
          documentRevision: params.request.documentRevision ?? null,
          executionId: params.executionId,
          nodeId: job.nodeId,
          outputCount: params.outputCount,
          ownerUserId: params.ownerUserId,
          workflowId: params.projectId,
        });
        const taskRunId = randomUUID();
        const taskRun = await db
          .insert(taskRuns)
          .values({
            assetIds: [],
            costCredits: 0,
            createdAt: now,
            documentRevision: params.request.documentRevision ?? null,
            executionId: params.executionId,
            id: taskRunId,
            inputData: buildTaskRunExecutionDocumentSnapshot({
              ...params,
              job,
              taskRunId,
            }),
            jobId: taskRunId,
            nodeExecutionId: nodeExecution.id,
            nodeId: job.nodeId,
            outputIndex: job.outputIndex,
            ownerUserId: params.ownerUserId,
            queuedAt: now,
            status: "queued",
            targetReason: nodeExecution.targetReason,
            updatedAt: now,
            version:
              params.versionOverride ??
              getGeneratorOutputAttempt(node, job.outputIndex),
            workflowId: params.projectId,
          })
          .onConflictDoNothing()
          .returning()
          .then((rows) => rows[0] ?? null);

        if (taskRun) {
          createdTasks.push({
            executionId: taskRun.executionId,
            jobId: taskRun.jobId,
            taskRunId: taskRun.id,
            userId: taskRun.ownerUserId,
          });
        }

        await db
          .update(nodeExecutions)
          .set({ dispatchedAt: now, status: "dispatched", updatedAt: now })
          .where(eq(nodeExecutions.id, nodeExecution.id));
      }

      return createdTasks;
    },
    catch: toTaskStoreError,
  });
}

export function claimQueuedWorkflowTaskRun(params: {
  taskRunId: string;
  userId: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      const now = new Date();
      const claimed = await db
        .update(taskRuns)
        .set({ startedAt: now, status: "running", updatedAt: now })
        .where(
          and(
            eq(taskRuns.id, params.taskRunId),
            eq(taskRuns.ownerUserId, params.userId),
            eq(taskRuns.status, "queued"),
          ),
        )
        .returning();

      if (claimed.length === 1)
        return { claimed: true, row: claimed[0] ?? null };

      const [existing] = await db
        .select()
        .from(taskRuns)
        .where(
          and(
            eq(taskRuns.id, params.taskRunId),
            eq(taskRuns.ownerUserId, params.userId),
          ),
        )
        .limit(1);
      return { claimed: false, row: existing ?? null };
    },
    catch: toTaskStoreError,
  });
}

export function getTaskRunExecutionDocumentSnapshot(row: TaskRunRow) {
  return row.inputData?.type === "workflow-task-run-execution-document-snapshot"
    ? row.inputData
    : null;
}
