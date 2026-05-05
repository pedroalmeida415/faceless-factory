import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { WorkflowDefinitionGraphDocument } from "~/lib/workflow/document";
import type {
  AssetKind,
  AssetSource,
  OutputTransformValueType,
  WorkflowOutputReviewStatus,
} from "~/lib/workflow/types";
import {
  type TaskRunFailureReasonType,
  type TaskRunStatus,
  taskRunFailureReasonTypeValues,
  taskRunStatusValues,
} from "~/lib/workflow-runtime/domain/task-run-state";

export const taskRunRuntimeStatusEnum = pgEnum(
  "task_run_runtime_status",
  taskRunStatusValues,
);

export const taskRunFailureReasonEnum = pgEnum(
  "task_run_failure_reason",
  taskRunFailureReasonTypeValues,
);

type CreditLedgerEntryKind =
  | "debit"
  | "refund"
  | "grant"
  | "purchase"
  | "adjustment";

type NodeExecutionStatus = "pending" | "dispatched";
type WorkflowExecutionTargetReason =
  | "node_run"
  | "workflow_run"
  | "dependency_run"
  | "review_regeneration";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified")
    .$defaultFn(() => false)
    .notNull(),
  image: text("image"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  creditBalance: bigint("credit_balance", { mode: "number" })
    .default(0)
    .notNull(),
  stripeCustomerId: text("stripe_customer_id").unique(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").$defaultFn(
    () => /* @__PURE__ */ new Date(),
  ),
  updatedAt: timestamp("updated_at").$defaultFn(
    () => /* @__PURE__ */ new Date(),
  ),
});

export const workflows = pgTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    document: jsonb("document")
      .$type<WorkflowDefinitionGraphDocument>()
      .notNull(),
    documentRevision: bigint("document_revision", { mode: "number" })
      .default(0)
      .notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    lastOpenedAt: timestamp("last_opened_at"),
  },
  (table) => ({
    ownerUpdatedAtIdx: index("workflows_owner_updated_at_idx").on(
      table.ownerUserId,
      table.updatedAt,
    ),
    ownerLastOpenedAtIdx: index("workflows_owner_last_opened_at_idx").on(
      table.ownerUserId,
      table.lastOpenedAt,
    ),
  }),
);

export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    source: text("source").$type<AssetSource>().notNull(),
    kind: text("kind").$type<AssetKind>().notNull(),
    taskRunId: text("task_run_id").references((): AnyPgColumn => taskRuns.id, {
      onDelete: "set null",
    }),
    storageProvider: text("storage_provider").notNull(),
    storageKey: text("storage_key"),
    cdnUrl: text("cdn_url"),
    textContent: text("text_content"),
    mimeType: text("mime_type").notNull(),
    fileName: text("file_name").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    model: text("model"),
    externalUri: text("external_uri"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    ownerCreatedAtIdx: index("assets_owner_created_at_idx").on(
      table.ownerUserId,
      table.createdAt,
    ),
    workflowCreatedAtIdx: index("assets_workflow_created_at_idx").on(
      table.workflowId,
      table.createdAt,
    ),
    taskRunIdx: index("assets_task_run_idx").on(table.taskRunId),
  }),
);

export const nodeExecutions = pgTable(
  "node_executions",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    executionId: text("execution_id").notNull(),
    documentRevision: bigint("document_revision", { mode: "number" }),
    status: text("status").$type<NodeExecutionStatus>().notNull(),
    outputCount: bigint("output_count", { mode: "number" }).notNull(),
    targetReason: text("target_reason")
      .$type<WorkflowExecutionTargetReason>()
      .notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    dispatchedAt: timestamp("dispatched_at"),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    workflowNodeCreatedIdx: index(
      "node_executions_workflow_node_created_idx",
    ).on(table.workflowId, table.nodeId, table.createdAt, table.id),
    workflowStatusUpdatedIdx: index(
      "node_executions_workflow_status_updated_idx",
    ).on(table.workflowId, table.status, table.updatedAt),
    ownerUpdatedAtIdx: index("node_executions_owner_updated_at_idx").on(
      table.ownerUserId,
      table.updatedAt,
    ),
    workflowExecutionNodeUnique: uniqueIndex(
      "node_executions_workflow_execution_node_unique",
    ).on(table.workflowId, table.executionId, table.nodeId),
    executionIdx: index("node_executions_execution_idx").on(table.executionId),
  }),
);

export const taskRuns = pgTable(
  "task_runs",
  {
    id: text("id").primaryKey(),
    nodeExecutionId: text("node_execution_id")
      .notNull()
      .references(() => nodeExecutions.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    outputIndex: bigint("output_index", { mode: "number" }).notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    itemIndex: bigint("item_index", { mode: "number" }),
    attempt: bigint("attempt", { mode: "number" }),
    executionId: text("execution_id").notNull(),
    jobId: text("job_id").notNull(),
    status: text("status").notNull(),
    runtimeStatus:
      taskRunRuntimeStatusEnum("runtime_status").$type<TaskRunStatus>(),
    targetReason: text("target_reason")
      .$type<WorkflowExecutionTargetReason>()
      .notNull(),
    valueType:
      text("value_type").$type<Exclude<OutputTransformValueType, null>>(),
    textValue: text("text_value"),
    assetIds: jsonb("asset_ids").$type<string[]>().default([]).notNull(),
    inputHash: text("input_hash"),
    idempotencyKey: text("idempotency_key"),
    model: text("model"),
    promptSnapshot: text("prompt_snapshot"),
    inputData: jsonb("input_data"),
    inputSnapshot: jsonb("input_snapshot"),
    reviewStatus: text("review_status").$type<WorkflowOutputReviewStatus>(),
    error: text("error"),
    creditCost: bigint("credit_cost", { mode: "number" }).notNull(),
    failureReason:
      taskRunFailureReasonEnum(
        "failure_reason",
      ).$type<TaskRunFailureReasonType>(),
    documentRevision: bigint("document_revision", { mode: "number" }),
    queuedAt: timestamp("queued_at"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    failedAt: timestamp("failed_at"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    nodeExecutionOutputVersionUnique: uniqueIndex(
      "task_runs_node_execution_output_version_unique",
    ).on(table.nodeExecutionId, table.outputIndex, table.version),
    idempotencyKeyUnique: uniqueIndex("task_runs_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    jobIdUnique: uniqueIndex("task_runs_job_id_unique").on(table.jobId),
    nodeExecutionOutputVersionIdx: index(
      "task_runs_node_execution_output_version_idx",
    ).on(table.nodeExecutionId, table.outputIndex, table.version),
    workflowTaskOutputCreatedIdx: index(
      "task_runs_workflow_task_output_created_idx",
    ).on(table.workflowId, table.nodeId, table.outputIndex, table.createdAt),
    workflowStatusUpdatedIdx: index("task_runs_workflow_status_updated_idx").on(
      table.workflowId,
      table.status,
      table.updatedAt,
    ),
    executionIdx: index("task_runs_execution_idx").on(table.executionId),
    runtimeActiveSlotUnique: uniqueIndex("task_runs_runtime_active_slot_unique")
      .on(table.nodeExecutionId, table.itemIndex)
      .where(
        sql`${table.runtimeStatus} in ('WAITING_UPSTREAM', 'QUEUED', 'RUNNING', 'PENDING_REVIEW')`,
      ),
    runtimeSlotAttemptIdx: index("task_runs_runtime_slot_attempt_idx").on(
      table.nodeExecutionId,
      table.itemIndex,
      table.attempt,
    ),
    runtimeStatusUpdatedIdx: index("task_runs_runtime_status_updated_idx").on(
      table.runtimeStatus,
      table.updatedAt,
    ),
  }),
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: text("id").primaryKey(),
    childTaskRunId: text("child_task_run_id")
      .notNull()
      .references(() => taskRuns.id, { onDelete: "cascade" }),
    requiredParentNodeExecutionId: text("required_parent_node_execution_id")
      .notNull()
      .references(() => nodeExecutions.id, { onDelete: "cascade" }),
    requiredParentNodeId: text("required_parent_node_id").notNull(),
    requiredParentItemIndex: bigint("required_parent_item_index", {
      mode: "number",
    }).notNull(),
    sourceHandle: text("source_handle"),
    targetHandle: text("target_handle"),
    targetNodeId: text("target_node_id").notNull(),
    resolvedParentTaskRunId: text("resolved_parent_task_run_id").references(
      () => taskRuns.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => ({
    childTaskRunIdx: index("task_dependencies_child_task_run_idx").on(
      table.childTaskRunId,
    ),
    requiredParentSlotIdx: index(
      "task_dependencies_required_parent_slot_idx",
    ).on(table.requiredParentNodeExecutionId, table.requiredParentItemIndex),
    childParentSlotUnique: uniqueIndex(
      "task_dependencies_child_parent_slot_unique",
    ).on(
      table.childTaskRunId,
      table.requiredParentNodeExecutionId,
      table.requiredParentItemIndex,
      table.sourceHandle,
      table.targetHandle,
    ),
    resolvedParentTaskRunIdx: index(
      "task_dependencies_resolved_parent_task_run_idx",
    ).on(table.resolvedParentTaskRunId),
  }),
);

export const creditLedgerEntries = pgTable(
  "credit_ledger_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    executionId: text("execution_id"),
    kind: text("kind").$type<CreditLedgerEntryKind>().notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    sourceKey: text("source_key").unique(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    userCreatedAtIdx: index("credit_ledger_entries_user_created_at_idx").on(
      table.userId,
      table.createdAt,
    ),
    executionIdIdx: index("credit_ledger_entries_execution_id_idx").on(
      table.executionId,
    ),
  }),
);

export const subscription = pgTable(
  "subscription",
  {
    id: text("id").primaryKey(),
    plan: text("plan").notNull(),
    referenceId: text("reference_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    status: text("status").default("incomplete").notNull(),
    periodStart: timestamp("period_start"),
    periodEnd: timestamp("period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false),
    cancelAt: timestamp("cancel_at"),
    canceledAt: timestamp("canceled_at"),
    endedAt: timestamp("ended_at"),
    seats: bigint("seats", { mode: "number" }),
    trialStart: timestamp("trial_start"),
    trialEnd: timestamp("trial_end"),
    billingInterval: text("billing_interval"),
    stripeScheduleId: text("stripe_schedule_id"),
  },
  (table) => ({
    referenceStatusIdx: index("subscription_reference_status_idx").on(
      table.referenceId,
      table.status,
    ),
    stripeSubscriptionIdIdx: index(
      "subscription_stripe_subscription_id_idx",
    ).on(table.stripeSubscriptionId),
  }),
);

export const userRelations = relations(user, ({ many }) => ({
  account: many(account),
  assets: many(assets),
  creditLedgerEntries: many(creditLedgerEntries),
  nodeExecutions: many(nodeExecutions),
  session: many(session),
  subscriptions: many(subscription),
  workflows: many(workflows),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const workflowsRelations = relations(workflows, ({ many, one }) => ({
  assets: many(assets),
  nodeExecutions: many(nodeExecutions),
  taskRuns: many(taskRuns),
  owner: one(user, {
    fields: [workflows.ownerUserId],
    references: [user.id],
  }),
}));

export const assetsRelations = relations(assets, ({ one }) => ({
  owner: one(user, {
    fields: [assets.ownerUserId],
    references: [user.id],
  }),
  workflow: one(workflows, {
    fields: [assets.workflowId],
    references: [workflows.id],
  }),
  producingTaskRun: one(taskRuns, {
    fields: [assets.taskRunId],
    references: [taskRuns.id],
  }),
}));

export const nodeExecutionsRelations = relations(
  nodeExecutions,
  ({ many, one }) => ({
    owner: one(user, {
      fields: [nodeExecutions.ownerUserId],
      references: [user.id],
    }),
    workflow: one(workflows, {
      fields: [nodeExecutions.workflowId],
      references: [workflows.id],
    }),
    requiredTaskDependencies: many(taskDependencies),
    taskRuns: many(taskRuns),
  }),
);

export const taskRunsRelations = relations(taskRuns, ({ many, one }) => ({
  childTaskRunDependencies: many(taskDependencies, {
    relationName: "childTaskRunDependencies",
  }),
  generatedAssets: many(assets),
  nodeExecution: one(nodeExecutions, {
    fields: [taskRuns.nodeExecutionId],
    references: [nodeExecutions.id],
  }),
  owner: one(user, {
    fields: [taskRuns.ownerUserId],
    references: [user.id],
  }),
  workflow: one(workflows, {
    fields: [taskRuns.workflowId],
    references: [workflows.id],
  }),
  resolvedParentTaskRunDependencies: many(taskDependencies, {
    relationName: "resolvedParentTaskRunDependencies",
  }),
}));

export const taskDependenciesRelations = relations(
  taskDependencies,
  ({ one }) => ({
    childTaskRun: one(taskRuns, {
      fields: [taskDependencies.childTaskRunId],
      references: [taskRuns.id],
      relationName: "childTaskRunDependencies",
    }),
    requiredParentNodeExecution: one(nodeExecutions, {
      fields: [taskDependencies.requiredParentNodeExecutionId],
      references: [nodeExecutions.id],
    }),
    resolvedParentTaskRun: one(taskRuns, {
      fields: [taskDependencies.resolvedParentTaskRunId],
      references: [taskRuns.id],
      relationName: "resolvedParentTaskRunDependencies",
    }),
  }),
);

export const creditLedgerEntriesRelations = relations(
  creditLedgerEntries,
  ({ one }) => ({
    user: one(user, {
      fields: [creditLedgerEntries.userId],
      references: [user.id],
    }),
  }),
);

export const subscriptionRelations = relations(subscription, ({ one }) => ({
  user: one(user, {
    fields: [subscription.referenceId],
    references: [user.id],
  }),
}));
