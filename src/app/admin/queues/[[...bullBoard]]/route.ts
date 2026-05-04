import { handle } from "hono/vercel";

import { getWorkflowRuntimeBoardApp } from "~/server/workflow-runtime/workflow-runtime-board";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = handle(getWorkflowRuntimeBoardApp());

export { handler as DELETE, handler as GET, handler as PATCH, handler as POST };
