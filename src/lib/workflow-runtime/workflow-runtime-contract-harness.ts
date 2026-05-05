import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { Effect } from "effect";

import {
  createEmptyWorkflowDocument,
  createWorkflowNode,
  toWorkflowDefinitionGraphDocument,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
  type WorkflowDocumentNode,
} from "~/lib/workflow/document";
import type { TaskRunStatus } from "~/lib/workflow-runtime/domain/task-run-state";
import {
  type ExecutableTaskRunInputSnapshot,
  isTaskRunInputSnapshot,
  type TaskRunInputSnapshot,
} from "~/lib/workflow-runtime/execution/task-run-input-snapshot";
import type {
  planWorkflowRun,
  WorkflowRunPlan,
} from "~/lib/workflow-runtime/planning/workflow-run-planner";
import type { createWorkflowRuntimeProviderExecutor } from "~/server/workflow-runtime/workflow-runtime-provider-executor";

export function assertPlanInvariants(
  plan: ReturnType<typeof unwrapPlan>,
  document: WorkflowDocument,
  existingTaskRuns: readonly {
    readonly nodeExecutionId: string;
    readonly itemIndex: number;
  }[],
) {
  const generatedNodeIds = new Set(
    document.nodes
      .filter((node) =>
        ["imageGenerator", "videoGenerator", "llmGenerator"].includes(
          node.kind,
        ),
      )
      .map((node) => node.id),
  );
  const taskRunsByNodeExecution = new Map<string, number>();
  for (const taskRun of plan.taskRunsToCreate) {
    taskRunsByNodeExecution.set(
      taskRun.nodeExecutionId,
      (taskRunsByNodeExecution.get(taskRun.nodeExecutionId) ?? 0) + 1,
    );
    if (taskRun.status === "QUEUED") {
      assert.ok(taskRun.inputSnapshot, `Queued ${taskRun.id} needs a snapshot`);
      assertProviderReadySnapshot(taskRun.inputSnapshot);
    }
    if (taskRun.status === "WAITING_UPSTREAM") {
      assert.ok(
        taskRun.inputSnapshot,
        `Waiting Upstream ${taskRun.id} needs frozen static material`,
      );
      assert.ok(
        plan.taskDependenciesToCreate.some(
          (dependency) => dependency.childTaskRunId === taskRun.id,
        ),
        `Waiting Upstream ${taskRun.id} needs generated-parent Task Dependencies`,
      );
    }
  }
  for (const execution of plan.nodeExecutionsToCreate) {
    assert.ok(
      taskRunsByNodeExecution.get(execution.id),
      `Executable Node Execution ${execution.id} must not be planned with zero Task Runs`,
    );
  }
  for (const dependency of plan.taskDependenciesToCreate) {
    const hasParentTaskRun = [
      ...plan.taskRunsToCreate,
      ...existingTaskRuns,
    ].some(
      (taskRun) =>
        taskRun.nodeExecutionId === dependency.parentNodeExecutionId &&
        taskRun.itemIndex === dependency.parentItemIndex,
    );
    assert.ok(generatedNodeIds.has(dependency.parentNodeId));
    assert.notEqual(dependency.parentNodeId, "prompt");
    assert.notEqual(dependency.parentNodeId, "asset");
    assert.notEqual(dependency.parentNodeId, "topic");
    assert.ok(
      hasParentTaskRun,
      `Dependency ${dependency.childTaskRunId} points to missing parent Task Run slot ${dependency.parentNodeExecutionId}/${dependency.parentItemIndex}`,
    );
  }
  assert.deepEqual(
    plan.workflowDefinition,
    toWorkflowDefinitionGraphDocument(document),
  );
}

export async function assertRuntimeInvariants(db: PgliteDatabase) {
  const waitingDependencies = await db.execute(sql`
    select tr.id as "taskRunId", count(td.id)::int as "dependencyCount"
    from task_runs tr
    left join task_dependencies td on td.child_task_run_id = tr.id
    where tr.runtime_status = 'WAITING_UPSTREAM'
    group by tr.id
  `);
  for (const row of waitingDependencies.rows) {
    assert.ok(
      Number(row.dependencyCount) > 0,
      `${row.taskRunId} waits without Task Dependencies`,
    );
  }

  const queuedSnapshots = await db.execute(sql`
    select id, input_snapshot as "inputSnapshot"
    from task_runs
    where runtime_status = 'QUEUED'
  `);
  for (const row of queuedSnapshots.rows) {
    assert.equal(
      isTaskRunInputSnapshot(row.inputSnapshot),
      true,
      `${row.id} needs an input snapshot`,
    );
    if (isTaskRunInputSnapshot(row.inputSnapshot)) {
      assertProviderReadySnapshot(row.inputSnapshot);
    }
  }

  const staticDependencies = await db.execute(sql`
    select child_task_run_id as "childTaskRunId", required_parent_node_id as "parentNodeId"
    from task_dependencies
    where required_parent_node_id in ('prompt', 'list', 'asset', 'topic', 'reference')
  `);
  assert.deepEqual(staticDependencies.rows, []);

  const missingParents = await db.execute(sql`
    select
      td.child_task_run_id as "childTaskRunId",
      td.required_parent_node_execution_id as "parentNodeExecutionId",
      td.required_parent_item_index as "parentItemIndex"
    from task_dependencies td
    where td.resolved_parent_task_run_id is null
      and not exists (
        select 1
        from task_runs parent
        where parent.node_execution_id = td.required_parent_node_execution_id
          and parent.item_index = td.required_parent_item_index
      )
  `);
  assert.deepEqual(missingParents.rows, []);

  const activeSlotDuplicates = await db.execute(sql`
    select node_execution_id as "nodeExecutionId", item_index as "itemIndex", count(*)::int as count
    from task_runs
    where runtime_status in ('WAITING_UPSTREAM', 'QUEUED', 'RUNNING', 'PENDING_REVIEW')
    group by node_execution_id, item_index
    having count(*) > 1
  `);
  assert.deepEqual(activeSlotDuplicates.rows, []);
}

function assertProviderReadySnapshot(snapshot: TaskRunInputSnapshot) {
  assert.notEqual(snapshot.providerInput.kind, "non-executable");
  assert.ok("request" in snapshot.providerInput);
  if ("request" in snapshot.providerInput) {
    assert.ok(snapshot.providerInput.request.idempotencyKey);
    assert.equal(
      snapshot.providerInput.request.idempotencyKey,
      snapshot.idempotencyKey,
    );
  }
}

export function assertNoColonJobIds(
  ...groups: readonly (
    | readonly { readonly jobId: string }[]
    | { readonly jobId: string }
    | null
  )[]
) {
  for (const group of groups) {
    const jobs = Array.isArray(group) ? group : group ? [group] : [];
    for (const job of jobs) {
      assert.equal(
        job.jobId.includes(":"),
        false,
        `${job.jobId} is not BullMQ-compatible`,
      );
      assert.equal(
        job.jobId.includes("~"),
        true,
        `${job.jobId} must use ~ as structural delimiter`,
      );
    }
  }
}

export function unwrapPlan(result: ReturnType<typeof planWorkflowRun>) {
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  return result.value;
}

export function nextId(prefix: string) {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

export function latestTaskRun(input: {
  readonly attempt?: number;
  readonly id: string;
  readonly itemIndex?: number;
  readonly nodeExecutionId: string;
  readonly status: TaskRunStatus;
}) {
  return {
    attempt: input.attempt ?? 0,
    id: input.id,
    itemIndex: input.itemIndex ?? 0,
    nodeExecutionId: input.nodeExecutionId,
    status: input.status,
  };
}

function makeNode<K extends Parameters<typeof createWorkflowNode>[0]>(
  kind: K,
  id: string,
): Extract<WorkflowDocumentNode, { kind: K }> {
  return { ...createWorkflowNode(kind, 0), id } as Extract<
    WorkflowDocumentNode,
    { kind: K }
  >;
}

export function simpleScriptDocument(): WorkflowDocument {
  const topic = makeNode("list", "topic");
  const prompt = makeNode("prompt", "prompt");
  return {
    edges: [
      {
        id: "topic-to-prompt",
        source: "topic",
        sourceHandle: "text",
        target: "prompt",
        targetHandle: "topic",
      },
      {
        id: "prompt-to-script",
        source: "prompt",
        sourceHandle: "text",
        target: "script",
        targetHandle: "prompt",
      },
    ],
    nodes: [
      topic.kind === "list" ? { ...topic, items: ["alpha", "beta"] } : topic,
      prompt.kind === "prompt"
        ? {
            ...prompt,
            prompt: "Write {{topic}}",
            variables: [{ key: "topic", label: "Topic" }],
          }
        : prompt,
      makeNode("llmGenerator", "script"),
    ],
    version: WORKFLOW_DOCUMENT_VERSION,
  };
}

export function generatedImageToGeneratedVideoDocument(): WorkflowDocument {
  const prompt = makeNode("prompt", "prompt");
  const image = makeNode("imageGenerator", "image");
  const video = makeNode("videoGenerator", "video");
  return {
    edges: [
      {
        id: "prompt-to-image",
        source: "prompt",
        sourceHandle: "text",
        target: "image",
        targetHandle: "prompt",
      },
      {
        id: "image-to-video",
        source: "image",
        sourceHandle: "images",
        target: "video",
        targetHandle: "image-input-0",
      },
    ],
    nodes: [
      prompt.kind === "prompt"
        ? { ...prompt, prompt: "Frozen visual prompt" }
        : prompt,
      image.kind === "imageGenerator"
        ? { ...image, reviewEnabled: true }
        : image,
      video,
    ],
    version: WORKFLOW_DOCUMENT_VERSION,
  };
}

export function activeGeneratorDocument(): WorkflowDocument {
  const node = createWorkflowNode("imageGenerator", 0, { x: 0, y: 0 });
  return {
    ...createEmptyWorkflowDocument(),
    nodes: [{ ...node, id: "active-generator" }],
  };
}

export function executableSnapshot(input: {
  readonly prompt: string;
  readonly taskRunId: string;
}): ExecutableTaskRunInputSnapshot {
  const targetNodeConfig = makeNode("llmGenerator", "snapshot-script");
  return {
    attempt: 0,
    documentRevision: 1,
    idempotencyKey: `task_run:${input.taskRunId}:attempt:0`,
    itemIndex: 0,
    kind: "task-run-input-snapshot",
    nodeExecutionId: "node-execution-snapshot",
    nodeId: "snapshot-script",
    providerInput: {
      kind: "llm-generation-request",
      request: {
        idempotencyKey: `task_run:${input.taskRunId}:attempt:0`,
        maxOutputTokens: 64,
        mode: null,
        model: "gemini-3-flash-preview",
        prompt: input.prompt,
        referenceImages: [],
        systemPrompt: null,
        temperature: 0.5,
        thinkingLevel: "LOW",
      },
    },
    resolvedParentTaskRuns: [],
    targetNodeConfig,
    taskRunId: input.taskRunId,
    version: 1,
    workflowDefinition: { edges: [], nodes: [targetNodeConfig], version: 9 },
  };
}

export class FakeVertexAi {
  llmCalls: Parameters<VertexLike["generateTextWithGemini3Flash"]>[0][] = [];
  imageCalls: Parameters<VertexLike["generateImagesWithNanoBananaPro"]>[0][] =
    [];
  videoCalls: Parameters<VertexLike["generateVideosWithVeo31"]>[0][] = [];

  generateTextWithGemini3Flash(
    params: Parameters<VertexLike["generateTextWithGemini3Flash"]>[0],
  ) {
    this.llmCalls.push(params);
    return Effect.succeed({
      model: "gemini-3-flash-preview" as const,
      responseText: "provider output",
      usage: {
        candidatesTokenCount: 0,
        promptTokenCount: 0,
        thoughtsTokenCount: 0,
        totalTokenCount: 0,
      },
    });
  }

  generateImagesWithNanoBananaPro(
    params: Parameters<VertexLike["generateImagesWithNanoBananaPro"]>[0],
  ) {
    this.imageCalls.push(params);
    return Effect.succeed({
      assets: [],
      model: "gemini-3-pro-image-preview" as const,
    });
  }

  generateVideosWithVeo31(
    params: Parameters<VertexLike["generateVideosWithVeo31"]>[0],
  ) {
    this.videoCalls.push(params);
    return Effect.succeed({
      assets: [],
      model: "veo-3.1-fast-generate-001" as const,
    });
  }
}

type VertexLike = Parameters<
  typeof createWorkflowRuntimeProviderExecutor
>[0]["vertexAi"];

export async function setupRuntimeContractTables(db: PgliteDatabase) {
  await db.execute(
    sql`create table "user" (id text primary key, name text not null, email text not null unique, credit_balance bigint not null default 0)`,
  );
  await db.execute(
    sql`create type task_run_runtime_status as enum ('WAITING_UPSTREAM','QUEUED','RUNNING','PENDING_REVIEW','APPROVED','REJECTED','CANCELLED','FAILED','UPSTREAM_FAILED')`,
  );
  await db.execute(
    sql`create type task_run_failure_reason as enum ('INSUFFICIENT_CREDITS','PROVIDER_FAILED','EXECUTION_FAILED','UPSTREAM_FAILED')`,
  );
  await db.execute(
    sql`create table assets (id text primary key, owner_user_id text not null, workflow_id text not null, source text not null, kind text not null, task_run_id text, storage_provider text not null, storage_key text, cdn_url text, text_content text, mime_type text not null, file_name text not null default '', size_bytes bigint not null default 0, model text, external_uri text, created_at timestamp not null default now(), deleted_at timestamp)`,
  );
  await db.execute(
    sql`create table node_executions (id text primary key, workflow_id text not null, owner_user_id text not null, node_id text not null, execution_id text not null, document_revision bigint, status text not null, output_count bigint not null, target_reason text not null, created_at timestamp not null default now(), dispatched_at timestamp, updated_at timestamp not null default now())`,
  );
  await db.execute(
    sql`create table task_runs (id text primary key, node_execution_id text not null, workflow_id text not null, owner_user_id text not null, node_id text not null, output_index bigint not null, version bigint not null, item_index bigint, attempt bigint, execution_id text not null, job_id text not null, status text not null, runtime_status task_run_runtime_status, target_reason text not null, asset_ids jsonb not null default '[]'::jsonb, input_snapshot jsonb, credit_cost bigint not null, failure_reason task_run_failure_reason, error text, created_at timestamp not null default now(), updated_at timestamp not null default now(), queued_at timestamp, started_at timestamp, finished_at timestamp, failed_at timestamp)`,
  );
  await db.execute(
    sql`create unique index task_runs_runtime_active_slot_unique on task_runs (node_execution_id, item_index) where runtime_status in ('WAITING_UPSTREAM','QUEUED','RUNNING','PENDING_REVIEW')`,
  );
  await db.execute(
    sql`create table task_dependencies (id text primary key, child_task_run_id text not null, required_parent_node_execution_id text not null, required_parent_node_id text not null, required_parent_item_index bigint not null, source_handle text, target_handle text, target_node_id text not null, resolved_parent_task_run_id text, created_at timestamp not null default now(), resolved_at timestamp)`,
  );
  await db.execute(
    sql`create unique index task_dependencies_child_parent_slot_unique on task_dependencies (child_task_run_id, required_parent_node_execution_id, required_parent_item_index, source_handle, target_handle)`,
  );
  await db.execute(
    sql`create table credit_ledger_entries (id text primary key, user_id text not null, execution_id text, kind text not null, amount bigint not null, balance_after bigint not null, reason text not null, source_key text unique, created_at timestamp not null default now())`,
  );
}

export async function resetRuntimeContractTables(db: PgliteDatabase) {
  await db.execute(
    sql`truncate table credit_ledger_entries, task_dependencies, task_runs, node_executions, assets, "user"`,
  );
}

export async function insertUser(
  db: PgliteDatabase,
  input: { readonly creditBalance: number; readonly id?: string },
) {
  const id = input.id ?? "owner-user";
  await db.execute(
    sql`insert into "user" (id, name, email, credit_balance) values (${id}, 'Owner User', ${`${id}@example.com`}, ${input.creditBalance}) on conflict (id) do update set credit_balance = excluded.credit_balance`,
  );
}

async function ensureUser(db: PgliteDatabase, ownerUserId: string) {
  await db.execute(
    sql`insert into "user" (id, name, email, credit_balance) values (${ownerUserId}, 'Owner User', ${`${ownerUserId}@example.com`}, 0) on conflict (id) do nothing`,
  );
}

export async function insertNodeExecution(
  db: PgliteDatabase,
  input: {
    readonly id: string;
    readonly nodeId?: string;
    readonly ownerUserId?: string;
  },
) {
  await db.execute(
    sql`insert into node_executions (id, workflow_id, owner_user_id, node_id, execution_id, status, output_count, target_reason) values (${input.id}, 'workflow-id', ${input.ownerUserId ?? "owner-user"}, ${input.nodeId ?? "node-id"}, ${input.id}, 'pending', 1, 'node_run') on conflict (id) do nothing`,
  );
}

export async function setNodeExecutionOutputCount(
  db: PgliteDatabase,
  input: { readonly nodeExecutionId: string; readonly outputCount: number },
) {
  await db.execute(
    sql`update node_executions set output_count = ${input.outputCount} where id = ${input.nodeExecutionId}`,
  );
}

export async function insertTaskRun(
  db: PgliteDatabase,
  input: {
    readonly attempt?: number;
    readonly creditCost?: number;
    readonly failureReason?: "INSUFFICIENT_CREDITS" | "PROVIDER_FAILED";
    readonly id: string;
    readonly inputSnapshot?: TaskRunInputSnapshot;
    readonly itemIndex?: number;
    readonly nodeExecutionId?: string;
    readonly nodeId?: string;
    readonly ownerUserId?: string;
    readonly runtimeStatus: TaskRunStatus;
  },
) {
  const attempt = input.attempt ?? 0;
  const nodeExecutionId = input.nodeExecutionId ?? `node-execution-${input.id}`;
  const nodeId = input.nodeId ?? "node-id";
  await ensureUser(db, input.ownerUserId ?? "owner-user");
  await insertNodeExecution(db, {
    id: nodeExecutionId,
    nodeId,
    ownerUserId: input.ownerUserId,
  });
  await db.execute(sql`
    insert into task_runs (id, node_execution_id, workflow_id, owner_user_id, node_id, output_index, version, item_index, attempt, execution_id, job_id, status, runtime_status, target_reason, input_snapshot, credit_cost, failure_reason, queued_at)
    values (${input.id}, ${nodeExecutionId}, 'workflow-id', ${input.ownerUserId ?? "owner-user"}, ${nodeId}, 0, ${attempt}, ${input.itemIndex ?? 0}, ${attempt}, 'legacy-execution-id', ${`legacy-job-${input.id}`}, 'queued', ${input.runtimeStatus}, 'node_run', ${input.inputSnapshot ?? executableSnapshot({ prompt: "", taskRunId: input.id })}, ${input.creditCost ?? 0}, ${input.failureReason ?? null}, now())
  `);
}

export async function insertTaskDependency(
  db: PgliteDatabase,
  input: {
    readonly childTaskRunId: string;
    readonly parentNodeExecutionId: string;
    readonly parentItemIndex?: number;
    readonly parentNodeId?: string;
    readonly sourceHandle?: string | null;
    readonly targetHandle?: string | null;
    readonly targetNodeId?: string;
  },
) {
  const parentItemIndex = input.parentItemIndex ?? 0;
  await db.execute(sql`
    insert into task_dependencies (id, child_task_run_id, required_parent_node_execution_id, required_parent_node_id, required_parent_item_index, source_handle, target_handle, target_node_id)
    values (${[input.childTaskRunId, input.parentNodeExecutionId, parentItemIndex, input.sourceHandle ?? "", input.targetHandle ?? ""].join("~")}, ${input.childTaskRunId}, ${input.parentNodeExecutionId}, ${input.parentNodeId ?? "node-id"}, ${parentItemIndex}, ${input.sourceHandle ?? null}, ${input.targetHandle ?? null}, ${input.targetNodeId ?? "node-id"})
  `);
}

export async function insertGeneratedTextAsset(
  db: PgliteDatabase,
  input: {
    readonly assetId: string;
    readonly taskRunId: string;
    readonly text: string;
  },
) {
  await db.execute(
    sql`insert into assets (id, owner_user_id, workflow_id, source, kind, task_run_id, storage_provider, text_content, mime_type, file_name, size_bytes) values (${input.assetId}, 'owner-user', 'workflow-id', 'generated', 'text', ${input.taskRunId}, 'inline', ${input.text}, 'text/plain', ${`${input.assetId}.txt`}, ${input.text.length})`,
  );
}

export async function insertGeneratedMediaAsset(
  db: PgliteDatabase,
  input: {
    readonly assetId: string;
    readonly cdnUrl?: string;
    readonly contentType?: string;
    readonly taskRunId: string;
  },
) {
  await db.execute(
    sql`insert into assets (id, owner_user_id, workflow_id, source, kind, task_run_id, storage_provider, storage_key, cdn_url, mime_type, file_name, size_bytes) values (${input.assetId}, 'owner-user', 'workflow-id', 'generated', 'image', ${input.taskRunId}, 'local', ${`generated/${input.assetId}.png`}, ${input.cdnUrl ?? `/api/assets/${input.assetId}`}, ${input.contentType ?? "image/png"}, ${`${input.assetId}.png`}, 1024)`,
  );
}

export async function setUserCreditBalance(
  db: PgliteDatabase,
  input: { readonly creditBalance: number; readonly userId?: string },
) {
  await db.execute(
    sql`update "user" set credit_balance = ${input.creditBalance} where id = ${input.userId ?? "owner-user"}`,
  );
}

export async function getTaskDependenciesForChild(
  db: PgliteDatabase,
  childTaskRunId: string,
) {
  const result = await db.execute(sql`
    select
      child_task_run_id as "childTaskRunId",
      required_parent_item_index as "requiredParentItemIndex",
      required_parent_node_id as "requiredParentNodeId",
      required_parent_node_execution_id as "requiredParentNodeExecutionId",
      resolved_parent_task_run_id as "resolvedParentTaskRunId",
      source_handle as "sourceHandle",
      target_handle as "targetHandle",
      target_node_id as "targetNodeId"
    from task_dependencies
    where child_task_run_id = ${childTaskRunId}
    order by id asc
  `);
  return result.rows.map((row) => ({
    childTaskRunId: String(row.childTaskRunId),
    requiredParentItemIndex: Number(row.requiredParentItemIndex),
    requiredParentNodeId: String(row.requiredParentNodeId),
    requiredParentNodeExecutionId: String(row.requiredParentNodeExecutionId),
    resolvedParentTaskRunId:
      row.resolvedParentTaskRunId === null
        ? null
        : String(row.resolvedParentTaskRunId),
    sourceHandle: row.sourceHandle === null ? null : String(row.sourceHandle),
    targetHandle: row.targetHandle === null ? null : String(row.targetHandle),
    targetNodeId: String(row.targetNodeId),
  }));
}

export async function getAssetsForTaskRun(
  db: PgliteDatabase,
  taskRunId: string,
) {
  const result = await db.execute(sql`
    select
      id,
      owner_user_id as "ownerUserId",
      workflow_id as "workflowId",
      source,
      kind,
      task_run_id as "taskRunId",
      cdn_url as "cdnUrl",
      text_content as text,
      mime_type as "mimeType"
    from assets
    where task_run_id = ${taskRunId}
    order by id asc
  `);
  return result.rows.map((row) => ({
    cdnUrl: row.cdnUrl,
    id: row.id,
    kind: row.kind,
    mimeType: row.mimeType,
    ownerUserId: row.ownerUserId,
    source: row.source,
    taskRunId: row.taskRunId,
    text: row.text,
    workflowId: row.workflowId,
  }));
}

export async function getTaskRunCreditState(
  db: PgliteDatabase,
  taskRunId: string,
) {
  const result = await db.execute(
    sql`select credit_cost as "creditCost", failure_reason as "failureReason", runtime_status as "runtimeStatus" from task_runs where id = ${taskRunId}`,
  );
  const row = result.rows[0];
  assert.ok(row);
  return {
    creditCost: row.creditCost === null ? null : Number(row.creditCost),
    failureReason: row.failureReason,
    runtimeStatus: row.runtimeStatus,
  };
}

export async function getTaskRunState(db: PgliteDatabase, taskRunId: string) {
  const result = await db.execute(
    sql`select input_snapshot as "inputSnapshot", runtime_status as "runtimeStatus" from task_runs where id = ${taskRunId}`,
  );
  const row = result.rows[0];
  assert.ok(row);
  assert.equal(isTaskRunInputSnapshot(row.inputSnapshot), true);
  if (!isTaskRunInputSnapshot(row.inputSnapshot)) {
    throw new Error(`Task Run ${taskRunId} has no valid input snapshot.`);
  }
  return {
    inputSnapshot: row.inputSnapshot,
    runtimeStatus: row.runtimeStatus,
  };
}

export async function getUserCreditBalance(db: PgliteDatabase, userId: string) {
  const result = await db.execute(
    sql`select credit_balance as "creditBalance" from "user" where id = ${userId}`,
  );
  return Number(result.rows[0]?.creditBalance ?? 0);
}

export function workflowRunPlan(input: {
  readonly nodeExecutionsToReuse?: readonly {
    readonly id: string;
    readonly nodeId: string;
  }[];
  readonly taskRunsToCreate?: readonly [];
}): WorkflowRunPlan {
  return {
    nodeExecutionsToCreate: [],
    nodeExecutionsToReuse: input.nodeExecutionsToReuse ?? [],
    runCostPreview: {
      excludedExisting: { items: [], totalCreditCost: 0 },
      failedBeforeQueue: { items: [], totalCreditCost: 0 },
      immediateDebitTotal: 0,
      items: [],
      newCostTotal: 0,
      queuedImmediate: { items: [], totalCreditCost: 0 },
      waitingUpstream: { items: [], totalCreditCost: 0 },
    },
    taskDependenciesToCreate: [],
    taskRunsToCreate: input.taskRunsToCreate ?? [],
    workflowDefinition: { edges: [], nodes: [], version: 9 as const },
  };
}

export function generatedTextAsset(assetId: string, text: string) {
  return {
    assetId,
    contentType: "text/plain",
    fileName: `${assetId}.txt`,
    kind: "text" as const,
    sizeBytes: text.length,
    storageProvider: "inline" as const,
    text,
  };
}

export function generatedImageAsset(assetId: string) {
  return {
    assetId,
    cdnUrl: `https://cdn.example.com/${assetId}.png`,
    contentType: "image/png",
    fileName: `${assetId}.png`,
    kind: "image" as const,
    sizeBytes: 1024,
    storageKey: `generated/${assetId}.png`,
    storageProvider: "s3" as const,
  };
}

export function broadcastGeneratedTextDocument(): WorkflowDocument {
  return {
    edges: [
      {
        id: "source-to-script",
        source: "source",
        sourceHandle: "text",
        target: "script",
        targetHandle: "prompt",
      },
    ],
    nodes: [
      makeNode("llmGenerator", "source"),
      makeNode("llmGenerator", "script"),
    ],
    version: WORKFLOW_DOCUMENT_VERSION,
  };
}

export function outputReorderDocument(): WorkflowDocument {
  const reorder = makeNode("outputReorder", "reorder");
  return {
    edges: [
      {
        id: "source-to-reorder",
        source: "source",
        sourceHandle: "text",
        target: "reorder",
        targetHandle: "input",
      },
      {
        id: "reorder-to-script",
        source: "reorder",
        sourceHandle: "output",
        target: "script",
        targetHandle: "prompt",
      },
    ],
    nodes: [
      makeNode("llmGenerator", "source"),
      reorder.kind === "outputReorder"
        ? {
            ...reorder,
            mode: "manual" as const,
            order: [1, 0],
            valueType: "text" as const,
          }
        : reorder,
      makeNode("llmGenerator", "script"),
    ],
    version: WORKFLOW_DOCUMENT_VERSION,
  };
}

export function eventContract(event: {
  readonly attempt: number;
  readonly itemIndex: number;
  readonly nodeExecutionId: string;
  readonly status: string;
  readonly taskRunId: string;
}) {
  return {
    attempt: event.attempt,
    itemIndex: event.itemIndex,
    nodeExecutionId: event.nodeExecutionId,
    status: event.status,
    taskRunId: event.taskRunId,
  };
}
