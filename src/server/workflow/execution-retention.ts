import { lt } from "drizzle-orm";
import { Effect } from "effect";

import {
  getErrorMessage,
  WorkflowInfrastructureError,
} from "~/lib/workflow/errors";
import { db } from "~/server/db";
import { nodeExecutions } from "~/server/db/schema";

const DEFAULT_EXECUTION_RETENTION_DAYS = 90;

export function cleanupRetainedWorkflowExecutions(
  params: { retentionDays?: number } = {},
) {
  return Effect.tryPromise({
    try: async () => {
      const retentionDays =
        params.retentionDays ?? DEFAULT_EXECUTION_RETENTION_DAYS;
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const deleted = await db
        .delete(nodeExecutions)
        .where(lt(nodeExecutions.updatedAt, cutoff))
        .returning({ id: nodeExecutions.id });

      return deleted.length;
    },
    catch: (cause) =>
      new WorkflowInfrastructureError({
        message: `Failed to clean workflow execution history: ${getErrorMessage(cause)}`,
        cause,
      }),
  });
}
