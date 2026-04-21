import { Effect } from "effect";
import { NextResponse } from "next/server";

import { ServerRuntime } from "~/effect/server/runtime";
import { assertWorkflowUploadFile } from "~/lib/workflow/assets";
import {
  getErrorMessage,
  WorkflowAuthorizationError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import type { UploadAssetResponse } from "~/lib/workflow/types";
import { auth } from "~/server/better-auth";
import { WorkflowStorage } from "~/server/workflow/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 420;

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const projectId = formData.get("projectId");

    if (!(file instanceof File)) {
      throw new WorkflowValidationError({ message: "Missing file upload." });
    }

    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new WorkflowValidationError({
        message: "A workflow project is required for uploads.",
      });
    }

    const kind = assertWorkflowUploadFile(file);
    const asset = await ServerRuntime.runPromise(
      Effect.gen(function* () {
        const workflowStorage = yield* WorkflowStorage;
        return yield* workflowStorage.saveFormFileAsAsset({
          file,
          kind,
          ownerUserId: session.user.id,
          projectId: projectId.trim(),
          source: "upload",
        });
      }),
    );

    return NextResponse.json({ asset } satisfies UploadAssetResponse);
  } catch (error) {
    const status =
      error instanceof WorkflowValidationError
        ? 400
        : error instanceof WorkflowAuthorizationError
          ? 403
          : 500;
    return NextResponse.json({ error: getErrorMessage(error) }, { status });
  }
}
