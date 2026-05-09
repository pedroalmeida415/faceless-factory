import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { desc, inArray, isNotNull, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  ExistingNodeRun,
  ExistingTask,
} from "~/features/runtime/planning/workflow-run-planner";
import * as schema from "~/server/database/schema";
import { DatabaseService } from "~/server/services/database";

export type RuntimePlanningState = {
  readonly latestNodeRuns: readonly ExistingNodeRun[];
  readonly latestTasks: readonly ExistingTask[];
};

export function getPlanningStateForWorkflow(params: {
  readonly ownerUserId: string;
  readonly workflowId: string;
}) {
  const query = Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const latestNodeRuns = yield* db
      .selectDistinctOn([schema.nodeRuns.nodeId], {
        id: schema.nodeRuns.id,
        nodeId: schema.nodeRuns.nodeId,
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
      return { latestNodeRuns, latestTasks: [] };
    }

    const latestNodeRunIds = latestNodeRuns.map(({ id }) => id);
    const latestTasks = yield* db
      .selectDistinctOn([schema.tasks.nodeRunId, schema.tasks.branchIndex], {
        creditCost: schema.tasks.creditCost,
        id: schema.tasks.id,
        branchIndex: schema.tasks.branchIndex,
        nodeRunId: schema.tasks.nodeRunId,
        nodeId: schema.tasks.nodeId,
        status: schema.tasks.runtimeStatus,
      })
      .from(schema.tasks)
      .where(
        sql`${schema.tasks.workflowId} = ${params.workflowId}
          and ${schema.tasks.ownerUserId} = ${params.ownerUserId}
          and ${inArray(schema.tasks.nodeRunId, latestNodeRunIds)}
          and ${isNotNull(schema.tasks.runtimeStatus)}
          and ${isNotNull(schema.tasks.branchIndex)}`,
      )
      .orderBy(
        schema.tasks.nodeRunId,
        schema.tasks.branchIndex,
        desc(schema.tasks.createdAt),
        desc(schema.tasks.id),
      );

    return {
      latestNodeRuns,
      latestTasks: latestTasks.map((row) => ({
        creditCost: requireNumber(row.creditCost),
        id: row.id,
        branchIndex: requireNumber(row.branchIndex),
        nodeRunId: row.nodeRunId,
        nodeId: row.nodeId,
        status: requireTaskStatus(row.status),
      })),
    };
  });

  return Effect.flatMap(DatabaseService, (database) => database.run(query));
}

function requireNumber(value: number | null): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  throw new TypeError("Expected integer database number value");
}

function requireTaskStatus(value: ExistingTask["status"] | null) {
  if (value) {
    return value;
  }
  throw new TypeError("Expected Task runtime status database value");
}
