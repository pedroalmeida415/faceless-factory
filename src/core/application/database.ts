import type { SqlClient } from "@effect/sql";
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import { Context } from "effect";
import type * as schema from "~/server/database/schema";

export type DatabaseClient = PgRemoteDatabase<typeof schema>;
export type DatabaseApi = DatabaseClient & {
  readonly sql: SqlClient.SqlClient;
};

export class Database extends Context.Tag("Database")<
  Database,
  DatabaseApi
>() {}
