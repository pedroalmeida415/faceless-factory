import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { desc, inArray, isNotNull, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  ExistingNodeExecution,
  ExistingTaskRun,
} from "~/features/runtime/planning/workflow-run-planner";
import * as schema from "~/server/database/schema";
import { DatabaseService } from "~/server/services/database";

export type RuntimePlanningState = {
  readonly latestNodeExecutions: readonly ExistingNodeExecution[];
  readonly latestTaskRuns: readonly ExistingTaskRun[];
};

export function getPlanningStateForWorkflow(params: {
  readonly ownerUserId: string;
  readonly workflowId: string;
}) {
  const query = Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const latestNodeExecutions = yield* db
      .selectDistinctOn([schema.nodeExecutions.nodeId], {
        id: schema.nodeExecutions.id,
        nodeId: schema.nodeExecutions.nodeId,
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
      return { latestNodeExecutions, latestTaskRuns: [] };
    }

    const latestNodeExecutionIds = latestNodeExecutions.map(({ id }) => id);
    const latestTaskRuns = yield* db
      .selectDistinctOn(
        [schema.taskRuns.nodeExecutionId, schema.taskRuns.itemIndex],
        {
          attempt: schema.taskRuns.attempt,
          creditCost: schema.taskRuns.creditCost,
          id: schema.taskRuns.id,
          itemIndex: schema.taskRuns.itemIndex,
          nodeExecutionId: schema.taskRuns.nodeExecutionId,
          nodeId: schema.taskRuns.nodeId,
          status: schema.taskRuns.runtimeStatus,
        },
      )
      .from(schema.taskRuns)
      .where(
        sql`${schema.taskRuns.workflowId} = ${params.workflowId}
          and ${schema.taskRuns.ownerUserId} = ${params.ownerUserId}
          and ${inArray(schema.taskRuns.nodeExecutionId, latestNodeExecutionIds)}
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

    return {
      latestNodeExecutions,
      latestTaskRuns: latestTaskRuns.map((row) => ({
        attempt: requireNumber(row.attempt),
        creditCost: requireNumber(row.creditCost),
        id: row.id,
        itemIndex: requireNumber(row.itemIndex),
        nodeExecutionId: row.nodeExecutionId,
        nodeId: row.nodeId,
        status: requireTaskRunStatus(row.status),
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

function requireTaskRunStatus(value: ExistingTaskRun["status"] | null) {
  if (value) {
    return value;
  }
  throw new TypeError("Expected Task Run runtime status database value");
}
