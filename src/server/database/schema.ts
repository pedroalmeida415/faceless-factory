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
import {
  type TaskFailureReasonType,
  type TaskStatus,
  taskFailureReasonTypeValues,
  taskStatusValues,
} from "~/features/runtime/domain/task-state";
import type { WorkflowDefinitionGraphDocument } from "~/features/workflow/document";
import type {
  AssetKind,
  AssetSource,
  OutputTransformValueType,
  WorkflowOutputReviewStatus,
} from "~/features/workflow/types";

export const taskRuntimeStatusEnum = pgEnum(
  "task_runtime_status",
  taskStatusValues,
);

export const taskFailureReasonEnum = pgEnum(
  "task_failure_reason",
  taskFailureReasonTypeValues,
);

type CreditLedgerEntryKind =
  | "debit"
  | "refund"
  | "grant"
  | "purchase"
  | "adjustment";

type NodeRunStatus = "pending" | "dispatched";
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
    taskId: text("task_id").references((): AnyPgColumn => tasks.id, {
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
    taskIdx: index("assets_task_idx").on(table.taskId),
  }),
);

export const nodeRuns = pgTable(
  "node_runs",
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
    status: text("status").$type<NodeRunStatus>().notNull(),
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
    workflowNodeCreatedIdx: index("node_runs_workflow_node_created_idx").on(
      table.workflowId,
      table.nodeId,
      table.createdAt,
      table.id,
    ),
    workflowStatusUpdatedIdx: index("node_runs_workflow_status_updated_idx").on(
      table.workflowId,
      table.status,
      table.updatedAt,
    ),
    ownerUpdatedAtIdx: index("node_runs_owner_updated_at_idx").on(
      table.ownerUserId,
      table.updatedAt,
    ),
    workflowExecutionNodeUnique: uniqueIndex(
      "node_runs_workflow_execution_node_unique",
    ).on(table.workflowId, table.executionId, table.nodeId),
    executionIdx: index("node_runs_execution_idx").on(table.executionId),
  }),
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    nodeRunId: text("node_run_id")
      .notNull()
      .references(() => nodeRuns.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    outputIndex: bigint("output_index", { mode: "number" }).notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    branchIndex: bigint("branch_index", { mode: "number" }),
    executionId: text("execution_id").notNull(),
    jobId: text("job_id").notNull(),
    status: text("status").notNull(),
    runtimeStatus: taskRuntimeStatusEnum("runtime_status").$type<TaskStatus>(),
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
      taskFailureReasonEnum("failure_reason").$type<TaskFailureReasonType>(),
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
    idempotencyKeyUnique: uniqueIndex("tasks_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    jobIdUnique: uniqueIndex("tasks_job_id_unique").on(table.jobId),
    nodeRunOutputVersionIdx: index("tasks_node_run_output_version_idx").on(
      table.nodeRunId,
      table.outputIndex,
      table.version,
    ),
    workflowTaskOutputCreatedIdx: index(
      "tasks_workflow_task_output_created_idx",
    ).on(table.workflowId, table.nodeId, table.outputIndex, table.createdAt),
    workflowStatusUpdatedIdx: index("tasks_workflow_status_updated_idx").on(
      table.workflowId,
      table.status,
      table.updatedAt,
    ),
    executionIdx: index("tasks_execution_idx").on(table.executionId),
    runtimeActiveSlotUnique: uniqueIndex("tasks_runtime_active_slot_unique")
      .on(table.nodeRunId, table.branchIndex)
      .where(
        sql`${table.runtimeStatus} in ('WAITING_UPSTREAM', 'QUEUED', 'RUNNING', 'PENDING_REVIEW')`,
      ),
    runtimeBranchCreatedIdx: index("tasks_runtime_branch_created_idx").on(
      table.nodeRunId,
      table.branchIndex,
      table.createdAt,
      table.id,
    ),
    runtimeStatusUpdatedIdx: index("tasks_runtime_status_updated_idx").on(
      table.runtimeStatus,
      table.updatedAt,
    ),
  }),
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: text("id").primaryKey(),
    childTaskId: text("child_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    requiredParentNodeRunId: text("required_parent_node_run_id")
      .notNull()
      .references(() => nodeRuns.id, { onDelete: "cascade" }),
    requiredParentNodeId: text("required_parent_node_id").notNull(),
    requiredParentBranchIndex: bigint("required_parent_branch_index", {
      mode: "number",
    }).notNull(),
    sourceHandle: text("source_handle"),
    targetHandle: text("target_handle"),
    targetNodeId: text("target_node_id").notNull(),
    resolvedParentTaskId: text("resolved_parent_task_id").references(
      () => tasks.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => ({
    childTaskIdx: index("task_dependencies_child_task_idx").on(
      table.childTaskId,
    ),
    requiredParentSlotIdx: index(
      "task_dependencies_required_parent_slot_idx",
    ).on(table.requiredParentNodeRunId, table.requiredParentBranchIndex),
    childParentSlotUnique: uniqueIndex(
      "task_dependencies_child_parent_slot_unique",
    ).on(
      table.childTaskId,
      table.requiredParentNodeRunId,
      table.requiredParentBranchIndex,
      table.sourceHandle,
      table.targetHandle,
    ),
    resolvedParentTaskIdx: index(
      "task_dependencies_resolved_parent_task_idx",
    ).on(table.resolvedParentTaskId),
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
  nodeRuns: many(nodeRuns),
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
  nodeRuns: many(nodeRuns),
  tasks: many(tasks),
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
  producingTask: one(tasks, {
    fields: [assets.taskId],
    references: [tasks.id],
  }),
}));

export const nodeRunsRelations = relations(nodeRuns, ({ many, one }) => ({
  owner: one(user, {
    fields: [nodeRuns.ownerUserId],
    references: [user.id],
  }),
  workflow: one(workflows, {
    fields: [nodeRuns.workflowId],
    references: [workflows.id],
  }),
  requiredTaskDependencies: many(taskDependencies),
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ many, one }) => ({
  childTaskDependencies: many(taskDependencies, {
    relationName: "childTaskDependencies",
  }),
  generatedAssets: many(assets),
  nodeRun: one(nodeRuns, {
    fields: [tasks.nodeRunId],
    references: [nodeRuns.id],
  }),
  owner: one(user, {
    fields: [tasks.ownerUserId],
    references: [user.id],
  }),
  workflow: one(workflows, {
    fields: [tasks.workflowId],
    references: [workflows.id],
  }),
  resolvedParentTaskDependencies: many(taskDependencies, {
    relationName: "resolvedParentTaskDependencies",
  }),
}));

export const taskDependenciesRelations = relations(
  taskDependencies,
  ({ one }) => ({
    childTask: one(tasks, {
      fields: [taskDependencies.childTaskId],
      references: [tasks.id],
      relationName: "childTaskDependencies",
    }),
    requiredParentNodeRun: one(nodeRuns, {
      fields: [taskDependencies.requiredParentNodeRunId],
      references: [nodeRuns.id],
    }),
    resolvedParentTask: one(tasks, {
      fields: [taskDependencies.resolvedParentTaskId],
      references: [tasks.id],
      relationName: "resolvedParentTaskDependencies",
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
