import { z } from "zod";

import {
  type TaskFailureReasonType,
  type TaskStatus,
  taskFailureReasonTypeValues,
  taskStatusValues,
} from "~/features/runtime/domain/task-state";

export const taskStatusEventStatusValues = taskStatusValues;
export const taskStatusEventFailureReasonValues = taskFailureReasonTypeValues;

const nonEmptyStringSchema = z.string().min(1);
const branchIndexSchema = z.number().int().nonnegative();
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
    failureReason: z.enum(taskStatusEventFailureReasonValues).optional(),
    branchIndex: branchIndexSchema,
    nodeRunId: nonEmptyStringSchema,
    output: RenderableTaskOutputSchema.optional(),
    status: z.enum(taskStatusEventStatusValues),
    taskId: nonEmptyStringSchema,
  });
}

export const TaskStatusEventSchema = createTaskStatusEventSchema();

export type TaskStatusEvent = z.infer<typeof TaskStatusEventSchema>;
export type TaskStatusEventStatus = TaskStatus;
export type TaskStatusEventFailureReason = TaskFailureReasonType;
export type RenderableTaskOutput = z.infer<typeof RenderableTaskOutputSchema>;
export type OrchestratorEventKind = "completion" | "failure" | "review";

export function buildExecutionJobId(input: { taskId: string }) {
  return `task~${input.taskId}~execute`;
}

export function buildWakeUpJobId(input: { parentTaskId: string }) {
  return `wake-up~${input.parentTaskId}`;
}

export function buildOrchestratorEventId(input: {
  taskId: string;
  kind: OrchestratorEventKind;
}) {
  return `task~${input.taskId}~orchestrator~${input.kind}`;
}

export function buildTaskStatusEvent(input: TaskStatusEvent) {
  return TaskStatusEventSchema.parse(input);
}

export function shouldApplyTaskStatusEvent(input: {
  event: Pick<TaskStatusEvent, "taskId">;
  currentRenderedTaskId: string | null;
}) {
  return input.event.taskId !== input.currentRenderedTaskId;
}
