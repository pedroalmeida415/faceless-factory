import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { WorkflowGraphDocument } from "~/lib/workflow/document";
import type {
  WorkflowExecutionRequestContext,
  WorkflowRunStatus,
} from "~/lib/workflow/execution/types";
import type {
  AssetKind,
  AssetSource,
  LaneTransformValueType,
  WorkflowReviewLaneStatus,
} from "~/lib/workflow/types";

type CreditLedgerEntryKind =
  | "debit"
  | "refund"
  | "grant"
  | "purchase"
  | "adjustment";

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

export const workflowProjects = pgTable(
  "workflow_projects",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    document: jsonb("document").$type<WorkflowGraphDocument>().notNull(),
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
    ownerUpdatedAtIdx: index("workflow_projects_owner_updated_at_idx").on(
      table.ownerUserId,
      table.updatedAt,
    ),
    ownerLastOpenedAtIdx: index(
      "workflow_projects_owner_last_opened_at_idx",
    ).on(table.ownerUserId, table.lastOpenedAt),
  }),
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => workflowProjects.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    documentRevision: bigint("document_revision", { mode: "number" }),
    status: text("status").$type<WorkflowRunStatus>().notNull(),
    targetNodeIds: jsonb("target_node_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    requestContext: jsonb("request_context")
      .$type<WorkflowExecutionRequestContext | null>()
      .default(null),
    accruedCostCredits: bigint("accrued_cost_credits", {
      mode: "number",
    })
      .default(0)
      .notNull(),
    finalCostCredits: bigint("final_cost_credits", { mode: "number" }),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    projectCreatedAtIdx: index("workflow_runs_project_created_at_idx").on(
      table.projectId,
      table.createdAt,
    ),
    ownerUpdatedAtIdx: index("workflow_runs_owner_updated_at_idx").on(
      table.ownerUserId,
      table.updatedAt,
    ),
    statusUpdatedAtIdx: index("workflow_runs_status_updated_at_idx").on(
      table.status,
      table.updatedAt,
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
    projectId: text("project_id").references(() => workflowProjects.id, {
      onDelete: "set null",
    }),
    source: text("source").$type<AssetSource>().notNull(),
    kind: text("kind").$type<AssetKind>().notNull(),
    storageProvider: text("storage_provider").notNull(),
    storageKey: text("storage_key"),
    mimeType: text("mime_type").notNull(),
    fileName: text("file_name").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    model: text("model"),
    externalUri: text("external_uri"),
    workflowRunId: text("workflow_run_id"),
    workflowNodeId: text("workflow_node_id"),
    workflowLaneIndex: bigint("workflow_lane_index", { mode: "number" }),
    workflowAttempt: bigint("workflow_attempt", { mode: "number" }),
    workflowDocumentRevision: bigint("workflow_document_revision", {
      mode: "number",
    }),
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
    projectCreatedAtIdx: index("assets_project_created_at_idx").on(
      table.projectId,
      table.createdAt,
    ),
    workflowProvenanceIdx: index("assets_workflow_provenance_idx").on(
      table.workflowRunId,
      table.workflowNodeId,
      table.workflowLaneIndex,
      table.workflowAttempt,
    ),
  }),
);

export const workflowLaneResults = pgTable(
  "workflow_lane_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => workflowProjects.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    laneIndex: bigint("lane_index", { mode: "number" }).notNull(),
    attempt: bigint("attempt", { mode: "number" }).notNull(),
    status: text("status").$type<"success" | "error">().notNull(),
    valueType:
      text("value_type").$type<Exclude<LaneTransformValueType, null>>(),
    textValue: text("text_value"),
    assetIds: jsonb("asset_ids").$type<string[]>().default([]).notNull(),
    inputHash: text("input_hash"),
    idempotencyKey: text("idempotency_key"),
    model: text("model"),
    promptSnapshot: text("prompt_snapshot"),
    error: text("error"),
    failedAt: timestamp("failed_at"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    laneAttemptUnique: uniqueIndex(
      "workflow_lane_results_lane_attempt_unique",
    ).on(table.runId, table.nodeId, table.laneIndex, table.attempt),
    idempotencyKeyUnique: uniqueIndex(
      "workflow_lane_results_idempotency_key_unique",
    ).on(table.idempotencyKey),
    projectRunIdx: index("workflow_lane_results_project_run_idx").on(
      table.projectId,
      table.runId,
    ),
    runNodeIdx: index("workflow_lane_results_run_node_idx").on(
      table.runId,
      table.nodeId,
    ),
    runNodeLaneIdx: index("workflow_lane_results_run_node_lane_idx").on(
      table.runId,
      table.nodeId,
      table.laneIndex,
    ),
  }),
);

export const workflowReviewLanes = pgTable(
  "workflow_review_lanes",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => workflowProjects.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    laneIndex: bigint("lane_index", { mode: "number" }).notNull(),
    attempt: bigint("attempt", { mode: "number" }).notNull(),
    valueType: text("value_type")
      .$type<Exclude<LaneTransformValueType, null>>()
      .notNull(),
    status: text("status").$type<WorkflowReviewLaneStatus>().notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    laneAttemptUnique: uniqueIndex(
      "workflow_review_lanes_lane_attempt_unique",
    ).on(table.runId, table.nodeId, table.laneIndex, table.attempt),
    runNodeStatusIdx: index("workflow_review_lanes_run_node_status_idx").on(
      table.runId,
      table.nodeId,
      table.status,
    ),
    projectRunIdx: index("workflow_review_lanes_project_run_idx").on(
      table.projectId,
      table.runId,
    ),
  }),
);

export const workflowArtifactLineage = pgTable(
  "workflow_artifact_lineage",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    sourceNodeId: text("source_node_id").notNull(),
    sourceLaneIndex: bigint("source_lane_index", { mode: "number" }).notNull(),
    sourceAttempt: bigint("source_attempt", { mode: "number" }).notNull(),
    dependentNodeId: text("dependent_node_id").notNull(),
    dependentLaneIndex: bigint("dependent_lane_index", {
      mode: "number",
    }).notNull(),
    dependentAttempt: bigint("dependent_attempt", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    dependencyUnique: uniqueIndex("workflow_artifact_lineage_unique").on(
      table.runId,
      table.sourceNodeId,
      table.sourceLaneIndex,
      table.sourceAttempt,
      table.dependentNodeId,
      table.dependentLaneIndex,
      table.dependentAttempt,
    ),
    dependentIdx: index("workflow_artifact_lineage_dependent_idx").on(
      table.runId,
      table.dependentNodeId,
      table.dependentLaneIndex,
      table.dependentAttempt,
    ),
    sourceIdx: index("workflow_artifact_lineage_source_idx").on(
      table.runId,
      table.sourceNodeId,
      table.sourceLaneIndex,
      table.sourceAttempt,
    ),
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
  session: many(session),
  subscriptions: many(subscription),
  workflowProjects: many(workflowProjects),
  workflowRuns: many(workflowRuns),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const workflowProjectsRelations = relations(
  workflowProjects,
  ({ many, one }) => ({
    assets: many(assets),
    laneResults: many(workflowLaneResults),
    reviewLanes: many(workflowReviewLanes),
    runs: many(workflowRuns),
    owner: one(user, {
      fields: [workflowProjects.ownerUserId],
      references: [user.id],
    }),
  }),
);

export const workflowRunsRelations = relations(workflowRuns, ({ one }) => ({
  owner: one(user, {
    fields: [workflowRuns.ownerUserId],
    references: [user.id],
  }),
  project: one(workflowProjects, {
    fields: [workflowRuns.projectId],
    references: [workflowProjects.id],
  }),
}));

export const assetsRelations = relations(assets, ({ one }) => ({
  owner: one(user, {
    fields: [assets.ownerUserId],
    references: [user.id],
  }),
  project: one(workflowProjects, {
    fields: [assets.projectId],
    references: [workflowProjects.id],
  }),
}));

export const workflowLaneResultsRelations = relations(
  workflowLaneResults,
  ({ one }) => ({
    owner: one(user, {
      fields: [workflowLaneResults.ownerUserId],
      references: [user.id],
    }),
    project: one(workflowProjects, {
      fields: [workflowLaneResults.projectId],
      references: [workflowProjects.id],
    }),
  }),
);

export const workflowReviewLanesRelations = relations(
  workflowReviewLanes,
  ({ one }) => ({
    owner: one(user, {
      fields: [workflowReviewLanes.ownerUserId],
      references: [user.id],
    }),
    project: one(workflowProjects, {
      fields: [workflowReviewLanes.projectId],
      references: [workflowProjects.id],
    }),
  }),
);

export const workflowArtifactLineageRelations = relations(
  workflowArtifactLineage,
  () => ({}),
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
