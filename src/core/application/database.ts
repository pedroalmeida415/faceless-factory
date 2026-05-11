import type { SqlClient } from "@effect/sql";
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import { Context } from "effect";

export type DatabaseClient = PgRemoteDatabase<Record<string, unknown>>;
export type DatabaseApi = DatabaseClient & {
  readonly sql: SqlClient.SqlClient;
};

export class Database extends Context.Tag("Database")<
  Database,
  DatabaseApi
>() {}
