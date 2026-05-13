import { SqlClient } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, Redacted } from "effect";
import { DatabaseService } from "~/core/application/database-service";
import { env } from "~/env";
import * as schema from "~/main/database/schema";

export const PgClientLive = PgClient.layer({
  url: Redacted.make(env.DATABASE_URL),
  maxConnections: 10,
  minConnections: 1,
});

export const DatabaseServiceLive = Layer.effect(
  DatabaseService,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.make({ schema });
    const sql = yield* SqlClient.SqlClient;

    // Use `db.sql.withTransaction(Effect.gen(...))` for transactions.
    // @effect/sql-drizzle turns query builders into Effects; the SqlClient
    // transaction keeps those queries on the transactional connection through
    // the Effect context. Avoid Drizzle's Promise-based `db.transaction(...)`.
    // `sql` is only to be used for transactions. Prefer db.query() or db.select() syntax.
    return DatabaseService.of(Object.assign(db, { sql }));
  }),
).pipe(Layer.provideMerge(PgClientLive));
