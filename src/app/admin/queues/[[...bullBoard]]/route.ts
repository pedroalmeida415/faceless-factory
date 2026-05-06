import { handle } from "hono/vercel";

import { getRuntimeBoardApp } from "~/features/runtime/server/board";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = handle(getRuntimeBoardApp());

export { handler as DELETE, handler as GET, handler as PATCH, handler as POST };
