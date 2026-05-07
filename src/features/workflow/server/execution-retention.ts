import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { lt } from "drizzle-orm";
import { Effect } from "effect";

import { nodeExecutions } from "~/server/database/schema";
import { DatabaseService } from "~/server/services/database";

const DEFAULT_EXECUTION_RETENTION_DAYS = 90;

export function cleanupRetainedWorkflowExecutions(
  params: { retentionDays?: number } = {},
) {
  return Effect.flatMap(DatabaseService, (database) =>
    database.run(
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle;
        const retentionDays =
          params.retentionDays ?? DEFAULT_EXECUTION_RETENTION_DAYS;
        const cutoff = new Date(
          Date.now() - retentionDays * 24 * 60 * 60 * 1000,
        );
        const deleted = yield* db
          .delete(nodeExecutions)
          .where(lt(nodeExecutions.updatedAt, cutoff))
          .returning({ id: nodeExecutions.id });

        return deleted.length;
      }),
    ),
  );
}
