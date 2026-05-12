import * as Reactivity from "@effect/experimental/Reactivity";
import { SqlClient } from "@effect/sql";
import type { Connection } from "@effect/sql/SqlConnection";
import { SqlError } from "@effect/sql/SqlError";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import * as PgClient from "@effect/sql-pg/PgClient";
import { PGlite } from "@electric-sql/pglite";
import { Effect, Layer } from "effect";
import { Database } from "~/core/application/database";
import {
  taskFailureReasonTypeValues,
  taskStatusValues,
} from "~/features/runtime/domain/task-state";
import * as schema from "~/server/database/schema";

export const DatabaseTest = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const pglite = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const database = new PGlite();
        await database.waitReady;
        await database.exec(coreRuntimeTestSchemaSql);
        return database;
      }),
      (database) => Effect.promise(() => database.close()),
    );
    const sql = yield* SqlClient.make({
      acquirer: Effect.succeed(makePgliteConnection(pglite)),
      compiler: PgClient.makeCompiler(),
      spanAttributes: [["db.system.name", "pglite"]],
      transactionAcquirer: Effect.succeed(makePgliteConnection(pglite)),
    }).pipe(Effect.provide(Reactivity.layer));
    const db = yield* PgDrizzle.make({ schema }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );

    return Database.of(Object.assign(db, { sql }));
  }),
);

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

const coreRuntimeTestSchemaSql = `
create type task_runtime_status as enum (${taskStatusValues.map(sqlString).join(", ")});
create type task_failure_reason as enum (${taskFailureReasonTypeValues.map(sqlString).join(", ")});

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

create table node_runs (
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

create table tasks (
  id text primary key,
  node_run_id text not null references node_runs(id) on delete cascade,
  workflow_id text not null references workflows(id) on delete cascade,
  owner_user_id text not null references "user"(id) on delete cascade,
  node_id text not null,
  output_index bigint not null,
  version bigint not null,
  branch_index bigint,
  execution_id text not null,
  job_id text not null unique,
  status text not null,
  runtime_status task_runtime_status,
  runtime_worker_id text,
  runtime_locked_until timestamp,
  runtime_attempt_count bigint not null default 0,
  runtime_next_attempt_at timestamp,
  runtime_last_error text,
  runtime_post_commit_processed_at timestamp,
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
  failure_reason task_failure_reason,
  document_revision bigint,
  queued_at timestamp,
  started_at timestamp,
  finished_at timestamp,
  failed_at timestamp,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

create unique index tasks_runtime_active_slot_unique
  on tasks (node_run_id, branch_index)
  where runtime_status in ('WAITING_UPSTREAM', 'QUEUED', 'RUNNING', 'PENDING_REVIEW');

create index tasks_runtime_ready_idx
  on tasks (runtime_status, runtime_next_attempt_at, runtime_locked_until, queued_at, created_at);

`;

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
