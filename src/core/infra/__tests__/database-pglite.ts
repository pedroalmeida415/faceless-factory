import * as Reactivity from "@effect/experimental/Reactivity";
import { SqlClient } from "@effect/sql";
import type { Connection } from "@effect/sql/SqlConnection";
import { SqlError } from "@effect/sql/SqlError";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import * as PgClient from "@effect/sql-pg/PgClient";
import { PGlite } from "@electric-sql/pglite";
import { Effect, Layer } from "effect";
import { DatabaseService } from "~/core/application/database-service";
import * as schema from "~/main/database/schema";

export const DatabaseServiceTest = Layer.scoped(
  DatabaseService,
  Effect.gen(function* () {
    const pglite = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const database = new PGlite();
        await database.waitReady;
        await database.exec(coreTestSchemaSql);
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

    return DatabaseService.of(Object.assign(db, { sql }));
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

const coreTestSchemaSql = `
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

create table session (
  id text primary key,
  expires_at timestamp not null,
  token text not null unique,
  created_at timestamp not null,
  updated_at timestamp not null,
  ip_address text,
  user_agent text,
  user_id text not null references "user"(id) on delete cascade
);

create table account (
  id text primary key,
  account_id text not null,
  provider_id text not null,
  user_id text not null references "user"(id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamp,
  refresh_token_expires_at timestamp,
  scope text,
  password text,
  created_at timestamp not null,
  updated_at timestamp not null
);

create table verification (
  id text primary key,
  identifier text not null,
  value text not null,
  expires_at timestamp not null,
  created_at timestamp,
  updated_at timestamp
);

create table credit_ledger_entries (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  kind text not null,
  amount bigint not null,
  balance_after bigint not null,
  reason text not null,
  source_key text unique,
  created_at timestamp not null default now()
);

create table subscription (
  id text primary key,
  plan text not null,
  reference_id text not null references "user"(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'incomplete',
  period_start timestamp,
  period_end timestamp,
  cancel_at_period_end boolean default false,
  cancel_at timestamp,
  canceled_at timestamp,
  ended_at timestamp,
  seats bigint,
  trial_start timestamp,
  trial_end timestamp,
  billing_interval text,
  stripe_schedule_id text
);

`;
