import { Effect } from "effect";
import { NextResponse } from "next/server";
import { auth } from "~/features/auth/server/config";
import { assertWorkflowUploadFile } from "~/features/workflow/assets";
import {
  getErrorMessage,
  WorkflowAuthorizationError,
  WorkflowValidationError,
} from "~/features/workflow/errors";
import type { UploadAssetResponse } from "~/features/workflow/types";
import { ServerRuntime } from "~/server/effect";
import { StorageService } from "~/server/services/storage";

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
        const storageService = yield* StorageService;
        return yield* storageService.saveFormFileAsAsset({
          file,
          kind,
          ownerUserId: session.user.id,
          workflowId: projectId.trim(),
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
