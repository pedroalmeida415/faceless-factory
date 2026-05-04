import { z } from "zod";

import {
  type TaskRunFailureReasonType,
  type TaskRunStatus,
  taskRunFailureReasonTypeValues,
  taskRunStatusValues,
} from "~/lib/workflow-runtime/domain/task-run-state";

export const taskStatusEventStatusValues = taskRunStatusValues;
export const taskStatusEventFailureReasonValues =
  taskRunFailureReasonTypeValues;

const nonEmptyStringSchema = z.string().min(1);
const attemptSchema = z.number().int().nonnegative();
const itemIndexSchema = z.number().int().nonnegative();
const renderableAssetUrlSchema = z.union([
  z.string().url(),
  z.string().startsWith("/"),
]);

export const CdnAssetRenderableOutputSchema = z.object({
  assetId: nonEmptyStringSchema,
  cdnUrl: renderableAssetUrlSchema,
  contentType: nonEmptyStringSchema,
  kind: z.literal("cdn-asset"),
});

export const InlineTextAssetRenderableOutputSchema = z.object({
  assetId: nonEmptyStringSchema,
  kind: z.literal("inline-text-asset"),
  text: z.string(),
});

export const RenderableTaskOutputSchema = z.discriminatedUnion("kind", [
  CdnAssetRenderableOutputSchema,
  InlineTextAssetRenderableOutputSchema,
]);

export function createTaskStatusEventSchema() {
  return z.object({
    attempt: attemptSchema,
    failureReason: z.enum(taskStatusEventFailureReasonValues).optional(),
    itemIndex: itemIndexSchema,
    nodeExecutionId: nonEmptyStringSchema,
    output: RenderableTaskOutputSchema.optional(),
    status: z.enum(taskStatusEventStatusValues),
    taskRunId: nonEmptyStringSchema,
  });
}

export const TaskStatusEventSchema = createTaskStatusEventSchema();

export type TaskStatusEvent = z.infer<typeof TaskStatusEventSchema>;
export type TaskStatusEventStatus = TaskRunStatus;
export type TaskStatusEventFailureReason = TaskRunFailureReasonType;
export type RenderableTaskOutput = z.infer<typeof RenderableTaskOutputSchema>;
export type OrchestratorEventKind = "completion" | "failure" | "review";

export function buildExecutionJobId(input: {
  taskRunId: string;
  attempt: number;
}) {
  return `task-run~${input.taskRunId}~attempt~${input.attempt}~execute`;
}

export function buildWakeUpJobId(input: { parentTaskRunId: string }) {
  return `wake-up~${input.parentTaskRunId}`;
}

export function buildOrchestratorEventId(input: {
  taskRunId: string;
  attempt: number;
  kind: OrchestratorEventKind;
}) {
  return `task-run~${input.taskRunId}~attempt~${input.attempt}~orchestrator~${input.kind}`;
}

export function buildTaskStatusEvent(input: TaskStatusEvent) {
  return TaskStatusEventSchema.parse(input);
}

export function shouldApplyTaskStatusEvent(input: {
  event: Pick<TaskStatusEvent, "attempt">;
  currentRenderedAttempt: number;
}) {
  return input.event.attempt >= input.currentRenderedAttempt;
}
