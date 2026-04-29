import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import {
  getErrorMessage,
  WorkflowInfrastructureError,
} from "~/lib/workflow/errors";
import { db } from "~/server/db";
import { taskRuns } from "~/server/db/schema";
import { enqueueWorkflowTaskRunJob } from "~/server/workflow/queue";

export function enqueueQueuedWorkflowTasks(
  params: { limit?: number; taskRunIds?: readonly string[] } = {},
) {
  return Effect.tryPromise({
    try: async () => {
      const rows = await db
        .select()
        .from(taskRuns)
        .where(
          and(
            eq(taskRuns.status, "queued"),
            params.taskRunIds?.length
              ? inArray(taskRuns.id, [...params.taskRunIds])
              : undefined,
          ),
        )
        .limit(params.limit ?? 100);
      let enqueuedCount = 0;

      for (const row of rows) {
        await enqueueWorkflowTaskRunJob(
          {
            executionId: row.executionId,
            taskRunId: row.id,
            type: "execute-task-run",
            userId: row.ownerUserId,
          },
          { jobId: row.jobId },
        );
        enqueuedCount += 1;
      }

      return enqueuedCount;
    },
    catch: (cause) =>
      new WorkflowInfrastructureError({
        message: `Failed to enqueue queued workflow tasks: ${getErrorMessage(cause)}`,
        cause,
      }),
  });
}
