import type { Config } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Drizzle commands.");
}

export default {
  dbCredentials: {
    url: databaseUrl,
  },
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
} satisfies Config;
