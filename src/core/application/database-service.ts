import type { SqlClient } from "@effect/sql";
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import { Context } from "effect";
import type * as schema from "~/main/database/schema";

export type DatabaseClient = PgRemoteDatabase<typeof schema>;
export type DatabaseServiceApi = DatabaseClient & {
  readonly sql: SqlClient.SqlClient;
};

export class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  DatabaseServiceApi
>() {}
