import type { Config } from "drizzle-kit";
import { env } from "./src/env";

export default {
  dbCredentials: {
    url: env.DATABASE_URL,
  },
  dialect: "postgresql",
  schema: "./src/server/database/schema.ts",
} satisfies Config;
