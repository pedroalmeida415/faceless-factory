import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { desc, inArray, isNotNull, sql } from "drizzle-orm";
import { Effect } from "effect";

import {
  type GeneratedAsset,
  projectGeneratedAssetToTaskOutput,
} from "~/features/runtime/assets/generated-asset-projection";
import type {
  RenderableTaskOutput,
  TaskStatusEventFailureReason,
  TaskStatusEventStatus,
} from "~/features/runtime/events/task-status-events";
import * as schema from "~/server/database/schema";
import { DatabaseService } from "~/server/services/database";

export type TaskRunProjectionSlot = {
  readonly attempt: number;
  readonly failureReason?: TaskStatusEventFailureReason;
  readonly itemIndex: number;
  readonly nodeExecutionId: string;
  readonly nodeId: string;
  readonly output?: RenderableTaskOutput;
  readonly status: TaskStatusEventStatus;
  readonly taskRunId: string;
};

export function getTaskRunProjectionForWorkflow(params: {
  readonly ownerUserId: string;
  readonly workflowId: string;
}) {
  const query = Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const latestNodeExecutions = yield* db
      .selectDistinctOn([schema.nodeExecutions.nodeId], {
        id: schema.nodeExecutions.id,
      })
      .from(schema.nodeExecutions)
      .where(
        sql`${schema.nodeExecutions.workflowId} = ${params.workflowId}
          and ${schema.nodeExecutions.ownerUserId} = ${params.ownerUserId}`,
      )
      .orderBy(
        schema.nodeExecutions.nodeId,
        desc(schema.nodeExecutions.createdAt),
        desc(schema.nodeExecutions.id),
      );
    if (!latestNodeExecutions.length) {
      return [];
    }

    const latestTaskRuns = yield* db
      .selectDistinctOn(
        [schema.taskRuns.nodeExecutionId, schema.taskRuns.itemIndex],
        {
          attempt: schema.taskRuns.attempt,
          failureReason: schema.taskRuns.failureReason,
          itemIndex: schema.taskRuns.itemIndex,
          nodeExecutionId: schema.taskRuns.nodeExecutionId,
          nodeId: schema.taskRuns.nodeId,
          status: schema.taskRuns.runtimeStatus,
          taskRunId: schema.taskRuns.id,
        },
      )
      .from(schema.taskRuns)
      .where(
        sql`${schema.taskRuns.workflowId} = ${params.workflowId}
          and ${schema.taskRuns.ownerUserId} = ${params.ownerUserId}
          and ${inArray(
            schema.taskRuns.nodeExecutionId,
            latestNodeExecutions.map(({ id }) => id),
          )}
          and ${isNotNull(schema.taskRuns.runtimeStatus)}
          and ${isNotNull(schema.taskRuns.itemIndex)}
          and ${isNotNull(schema.taskRuns.attempt)}`,
      )
      .orderBy(
        schema.taskRuns.nodeExecutionId,
        schema.taskRuns.itemIndex,
        desc(schema.taskRuns.attempt),
        desc(schema.taskRuns.id),
      );
    if (!latestTaskRuns.length) {
      return [];
    }

    const assets = yield* db
      .select({
        assetId: schema.assets.id,
        cdnUrl: schema.assets.cdnUrl,
        contentType: schema.assets.mimeType,
        kind: schema.assets.kind,
        taskRunId: schema.assets.taskRunId,
        text: schema.assets.textContent,
      })
      .from(schema.assets)
      .where(
        sql`${inArray(
          schema.assets.taskRunId,
          latestTaskRuns.map(({ taskRunId }) => taskRunId),
        )}
          and ${schema.assets.source} = 'generated'
          and ${schema.assets.deletedAt} is null`,
      )
      .orderBy(schema.assets.createdAt, schema.assets.id);

    const assetsByTaskRunId = new Map<string, GeneratedAsset[]>();
    for (const taskRun of latestTaskRuns) {
      assetsByTaskRunId.set(taskRun.taskRunId, []);
    }
    for (const row of assets) {
      const asset = optionalGeneratedAssetFromRow(row);
      if (asset && row.taskRunId) {
        assetsByTaskRunId.get(row.taskRunId)?.push(asset);
      }
    }

    return latestTaskRuns.map((row) => {
      const failureReason = row.failureReason ?? undefined;
      const slot = {
        attempt: requireNumber(row.attempt),
        ...(failureReason ? { failureReason } : {}),
        itemIndex: requireNumber(row.itemIndex),
        nodeExecutionId: row.nodeExecutionId,
        nodeId: row.nodeId,
        status: requireTaskStatus(row.status),
        taskRunId: row.taskRunId,
      } satisfies TaskRunProjectionSlot;
      const output = projectGeneratedAssetToTaskOutput(
        assetsByTaskRunId.get(slot.taskRunId) ?? [],
      );
      return output.kind === "INVALID_PRIMARY_GENERATED_ASSET_COUNT"
        ? slot
        : { ...slot, output };
    });
  });

  return Effect.flatMap(DatabaseService, (database) => database.run(query));
}

function optionalGeneratedAssetFromRow(row: {
  readonly assetId: string;
  readonly cdnUrl: string | null;
  readonly contentType: string;
  readonly kind: string;
  readonly text: string | null;
}): GeneratedAsset | null {
  if (row.kind === "text") {
    return { assetId: row.assetId, kind: row.kind, text: row.text ?? "" };
  }
  if ((row.kind === "image" || row.kind === "video") && row.cdnUrl) {
    return {
      assetId: row.assetId,
      cdnUrl: row.cdnUrl,
      contentType: row.contentType,
      kind: row.kind,
    };
  }
  return null;
}

function requireNumber(value: number | null): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  throw new TypeError("Expected integer database number value");
}

function requireTaskStatus(value: TaskStatusEventStatus | null) {
  if (value) {
    return value;
  }
  throw new TypeError("Expected Task Run runtime status database value");
}
