import { Effect } from "effect";
import { NextResponse } from "next/server";

import { ServerRuntime } from "~/effect/server/runtime";
import { getErrorMessage } from "~/lib/workflow/errors";
import { WorkflowStorage } from "~/server/workflow/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string[] }> },
) {
  try {
    const { slug } = await context.params;
    const relativePath = slug.join("/");
    const { data, mimeType } = await ServerRuntime.runPromise(
      Effect.gen(function* () {
        const workflowStorage = yield* WorkflowStorage;
        return yield* workflowStorage.readAssetByPath(relativePath);
      }),
    );
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 404 },
    );
  }
}
