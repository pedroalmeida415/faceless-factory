import * as Reactivity from "@effect/experimental/Reactivity";
import { SqlClient } from "@effect/sql";
import type { Connection } from "@effect/sql/SqlConnection";
import { SqlError } from "@effect/sql/SqlError";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import * as PgClient from "@effect/sql-pg/PgClient";
import { PGlite } from "@electric-sql/pglite";
import type { DrizzleConfig, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { Context, Effect, Layer, Redacted } from "effect";
import postgres from "postgres";

import { env } from "~/env";
import {
  taskRunFailureReasonTypeValues,
  taskRunStatusValues,
} from "~/features/runtime/domain/task-run-state";
import * as schema from "~/server/database/schema";

const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};

const conn = globalForDb.conn ?? postgres(env.DATABASE_URL);
if (env.NODE_ENV !== "production") {
  globalForDb.conn = conn;
}

export const db = drizzlePostgres(conn, { schema });

export type DatabaseServiceSqlServices =
  | SqlClient.SqlClient
  | PgDrizzle.PgDrizzle;

export class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  {
    readonly execute: (
      query: SQL,
    ) => Effect.Effect<
      { readonly rows: readonly Record<string, unknown>[] },
      SqlError
    >;
    readonly run: <A, E>(
      effect: Effect.Effect<A, E, DatabaseServiceSqlServices>,
    ) => Effect.Effect<A, E>;
    readonly transaction: <A, E>(
      effect: Effect.Effect<A, E, DatabaseServiceSqlServices>,
    ) => Effect.Effect<A, E | SqlError>;
  }
>() {}

const DatabasePgClientLive = PgClient.layer({
  url: Redacted.make(env.DATABASE_URL),
});

export const DatabaseServiceLive = Layer.effect(
  DatabaseService,
  Effect.map(Effect.context<DatabaseServiceSqlServices>(), makeDatabaseService),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      DatabasePgClientLive,
      PgDrizzle.layerWithConfig({ schema } as unknown as DrizzleConfig).pipe(
        Layer.provide(DatabasePgClientLive),
      ),
    ),
  ),
);

export const DatabaseServiceTest = Layer.scoped(
  DatabaseService,
  Effect.gen(function* () {
    const pglite = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const database = new PGlite();
        await database.waitReady;
        await database.exec(runtimeTestSchemaSql);
        return database;
      }),
      (database) => Effect.promise(() => database.close()),
    );
    const connection = makePgliteConnection(pglite);
    const sqlClient = yield* SqlClient.make({
      acquirer: Effect.succeed(connection),
      compiler: PgClient.makeCompiler(),
      spanAttributes: [["db.system.name", "pglite"]],
      transactionAcquirer: Effect.succeed(connection),
    }).pipe(Effect.provide(Reactivity.layer));
    const drizzleDb = drizzle(pglite, { schema });
    const pgDrizzle = yield* PgDrizzle.makeWithConfig({
      schema,
    } as unknown as DrizzleConfig).pipe(
      Effect.provideService(SqlClient.SqlClient, sqlClient),
    );
    const context = Context.make(SqlClient.SqlClient, sqlClient).pipe(
      Context.add(PgDrizzle.PgDrizzle, pgDrizzle),
    );

    return makeDatabaseService(context, (query) =>
      Effect.tryPromise({
        catch: (cause) =>
          new SqlError({
            cause,
            message: "Failed to execute PGLite Drizzle query",
          }),
        try: async () => {
          const result = await drizzleDb.execute(query);
          if (Array.isArray(result)) {
            return { rows: result as readonly Record<string, unknown>[] };
          }
          return {
            rows: (
              result as { readonly rows: readonly Record<string, unknown>[] }
            ).rows,
          };
        },
      }),
    );
  }),
);

export function makeDatabaseService(
  context: Context.Context<DatabaseServiceSqlServices>,
  executeQuery?: Context.Tag.Service<typeof DatabaseService>["execute"],
): Context.Tag.Service<typeof DatabaseService> {
  const drizzleDb = Context.unsafeGet(context, PgDrizzle.PgDrizzle);
  const run = <A, E>(effect: Effect.Effect<A, E, DatabaseServiceSqlServices>) =>
    Effect.provide(effect, context);

  return {
    execute:
      executeQuery ??
      ((query) =>
        run(
          Effect.map(drizzleDb.execute(query), (result) => {
            if (Array.isArray(result)) {
              return { rows: result as readonly Record<string, unknown>[] };
            }
            return {
              rows: (
                result as {
                  readonly rows: readonly Record<string, unknown>[];
                }
              ).rows,
            };
          }),
        )),
    run,
    transaction: (effect) =>
      run(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.withTransaction(effect),
        ),
      ),
  };
}

function makePgliteConnection(pglite: PGlite): Connection {
  const queryObjects = (sql: string, params: ReadonlyArray<unknown>) =>
    Effect.tryPromise({
      catch: (cause) =>
        new SqlError({ cause, message: "Failed to execute PGLite query" }),
      try: () =>
        pglite.query<Record<string, unknown>>(sql, [...params], {
          rowMode: "object",
        }),
    });
  const queryArrays = (sql: string, params: ReadonlyArray<unknown>) =>
    Effect.tryPromise({
      catch: (cause) =>
        new SqlError({ cause, message: "Failed to execute PGLite query" }),
      try: () =>
        pglite.query<readonly unknown[]>(sql, [...params], {
          rowMode: "array",
        }),
    });

  return {
    execute(sql, params, transformRows) {
      const rows = Effect.map(
        queryObjects(sql, params),
        (result) => result.rows,
      );
      return transformRows
        ? Effect.map(rows, (rows) => transformRows(rows))
        : rows;
    },
    executeRaw(sql, params) {
      return queryObjects(sql, params);
    },
    executeStream() {
      return Effect.dieMessage("PGLite test SqlClient does not stream rows");
    },
    executeUnprepared(sql, params, transformRows) {
      const rows = Effect.map(
        queryObjects(sql, params),
        (result) => result.rows,
      );
      return transformRows
        ? Effect.map(rows, (rows) => transformRows(rows))
        : rows;
    },
    executeValues(sql, params) {
      return Effect.map(queryArrays(sql, params), (result) => result.rows);
    },
  };
}

const runtimeTestSchemaSql = `
create type task_run_runtime_status as enum (${taskRunStatusValues.map(sqlString).join(", ")});
create type task_run_failure_reason as enum (${taskRunFailureReasonTypeValues.map(sqlString).join(", ")});

create table "user" (
  id text primary key,
  name text not null,
  email text not null unique,
  email_verified boolean not null default false,
  image text,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now(),
  credit_balance bigint not null default 0,
  stripe_customer_id text unique
);

create table workflows (
  id text primary key,
  owner_user_id text not null references "user"(id) on delete cascade,
  name text not null,
  document jsonb not null,
  document_revision bigint not null default 0,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now(),
  last_opened_at timestamp
);

create table node_executions (
  id text primary key,
  workflow_id text not null references workflows(id) on delete cascade,
  owner_user_id text not null references "user"(id) on delete cascade,
  node_id text not null,
  execution_id text not null,
  document_revision bigint,
  status text not null,
  output_count bigint not null,
  target_reason text not null,
  created_at timestamp not null default now(),
  dispatched_at timestamp,
  updated_at timestamp not null default now()
);

create table task_runs (
  id text primary key,
  node_execution_id text not null references node_executions(id) on delete cascade,
  workflow_id text not null references workflows(id) on delete cascade,
  owner_user_id text not null references "user"(id) on delete cascade,
  node_id text not null,
  output_index bigint not null,
  version bigint not null,
  item_index bigint,
  attempt bigint,
  execution_id text not null,
  job_id text not null unique,
  status text not null,
  runtime_status task_run_runtime_status,
  target_reason text not null,
  value_type text,
  text_value text,
  asset_ids jsonb not null default '[]'::jsonb,
  input_hash text,
  idempotency_key text unique,
  model text,
  prompt_snapshot text,
  input_data jsonb,
  input_snapshot jsonb,
  review_status text,
  error text,
  credit_cost bigint not null,
  failure_reason task_run_failure_reason,
  document_revision bigint,
  queued_at timestamp,
  started_at timestamp,
  finished_at timestamp,
  failed_at timestamp,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now(),
  unique (node_execution_id, output_index, version)
);

create unique index task_runs_runtime_active_slot_unique
  on task_runs (node_execution_id, item_index)
  where runtime_status in ('WAITING_UPSTREAM', 'QUEUED', 'RUNNING', 'PENDING_REVIEW');

create table task_dependencies (
  id text primary key,
  child_task_run_id text not null references task_runs(id) on delete cascade,
  required_parent_node_execution_id text not null references node_executions(id) on delete cascade,
  required_parent_node_id text not null,
  required_parent_item_index bigint not null,
  source_handle text,
  target_handle text,
  target_node_id text not null,
  resolved_parent_task_run_id text references task_runs(id) on delete set null,
  created_at timestamp not null default now(),
  resolved_at timestamp,
  unique (child_task_run_id, required_parent_node_execution_id, required_parent_item_index, source_handle, target_handle)
);

create table credit_ledger_entries (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  execution_id text,
  kind text not null,
  amount bigint not null,
  balance_after bigint not null,
  reason text not null,
  source_key text unique,
  created_at timestamp not null default now()
);

create table assets (
  id text primary key,
  owner_user_id text not null references "user"(id) on delete cascade,
  workflow_id text not null references workflows(id) on delete cascade,
  source text not null,
  kind text not null,
  task_run_id text references task_runs(id) on delete set null,
  storage_provider text not null,
  storage_key text,
  cdn_url text,
  text_content text,
  mime_type text not null,
  file_name text not null,
  size_bytes bigint not null,
  model text,
  external_uri text,
  created_at timestamp not null default now(),
  deleted_at timestamp
);
`;

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
