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

export type TaskProjectionSlot = {
  readonly failureReason?: TaskStatusEventFailureReason;
  readonly branchIndex: number;
  readonly nodeRunId: string;
  readonly nodeId: string;
  readonly output?: RenderableTaskOutput;
  readonly status: TaskStatusEventStatus;
  readonly taskId: string;
};

export function getTaskProjectionForWorkflow(params: {
  readonly ownerUserId: string;
  readonly workflowId: string;
}) {
  const query = Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const latestNodeRuns = yield* db
      .selectDistinctOn([schema.nodeRuns.nodeId], {
        id: schema.nodeRuns.id,
      })
      .from(schema.nodeRuns)
      .where(
        sql`${schema.nodeRuns.workflowId} = ${params.workflowId}
          and ${schema.nodeRuns.ownerUserId} = ${params.ownerUserId}`,
      )
      .orderBy(
        schema.nodeRuns.nodeId,
        desc(schema.nodeRuns.createdAt),
        desc(schema.nodeRuns.id),
      );
    if (!latestNodeRuns.length) {
      return [];
    }

    const latestTasks = yield* db
      .selectDistinctOn([schema.tasks.nodeRunId, schema.tasks.branchIndex], {
        failureReason: schema.tasks.failureReason,
        branchIndex: schema.tasks.branchIndex,
        nodeRunId: schema.tasks.nodeRunId,
        nodeId: schema.tasks.nodeId,
        status: schema.tasks.runtimeStatus,
        taskId: schema.tasks.id,
      })
      .from(schema.tasks)
      .where(
        sql`${schema.tasks.workflowId} = ${params.workflowId}
          and ${schema.tasks.ownerUserId} = ${params.ownerUserId}
          and ${inArray(
            schema.tasks.nodeRunId,
            latestNodeRuns.map(({ id }) => id),
          )}
          and ${isNotNull(schema.tasks.runtimeStatus)}
          and ${isNotNull(schema.tasks.branchIndex)}
          and ${isNotNull(schema.tasks.createdAt)}`,
      )
      .orderBy(
        schema.tasks.nodeRunId,
        schema.tasks.branchIndex,
        desc(schema.tasks.createdAt),
        desc(schema.tasks.id),
      );
    if (!latestTasks.length) {
      return [];
    }

    const assets = yield* db
      .select({
        assetId: schema.assets.id,
        cdnUrl: schema.assets.cdnUrl,
        contentType: schema.assets.mimeType,
        kind: schema.assets.kind,
        taskId: schema.assets.taskId,
        text: schema.assets.textContent,
      })
      .from(schema.assets)
      .where(
        sql`${inArray(
          schema.assets.taskId,
          latestTasks.map(({ taskId }) => taskId),
        )}
          and ${schema.assets.source} = 'generated'
          and ${schema.assets.deletedAt} is null`,
      )
      .orderBy(schema.assets.createdAt, schema.assets.id);

    const assetsByTaskId = new Map<string, GeneratedAsset[]>();
    for (const task of latestTasks) {
      assetsByTaskId.set(task.taskId, []);
    }
    for (const row of assets) {
      const asset = optionalGeneratedAssetFromRow(row);
      if (asset && row.taskId) {
        assetsByTaskId.get(row.taskId)?.push(asset);
      }
    }

    return latestTasks.map((row) => {
      const failureReason = row.failureReason ?? undefined;
      const slot = {
        ...(failureReason ? { failureReason } : {}),
        branchIndex: requireNumber(row.branchIndex),
        nodeRunId: row.nodeRunId,
        nodeId: row.nodeId,
        status: requireTaskStatus(row.status),
        taskId: row.taskId,
      } satisfies TaskProjectionSlot;
      const output = projectGeneratedAssetToTaskOutput(
        assetsByTaskId.get(slot.taskId) ?? [],
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
  throw new TypeError("Expected Task runtime status database value");
}
