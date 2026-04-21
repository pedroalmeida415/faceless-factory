import { Effect } from "effect";
import { NextResponse } from "next/server";

import { ServerRuntime } from "~/effect/server/runtime";
import { getErrorMessage } from "~/lib/workflow/errors";
import { auth } from "~/server/better-auth";
import { WorkflowStorage } from "~/server/workflow/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string[] }> },
) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await context.params;
    const assetId = slug[0];
    if (!assetId) {
      return NextResponse.json({ error: "Asset not found." }, { status: 404 });
    }

    const { data, externalUri, mimeType } = await ServerRuntime.runPromise(
      Effect.gen(function* () {
        const workflowStorage = yield* WorkflowStorage;
        return yield* workflowStorage.readAssetById({
          assetId,
          userId: session.user.id,
        });
      }),
    );

    if (externalUri) {
      return NextResponse.redirect(externalUri, { status: 302 });
    }

    if (!data) {
      return NextResponse.json({ error: "Asset not found." }, { status: 404 });
    }

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
