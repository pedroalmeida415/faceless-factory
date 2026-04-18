import { Effect } from "effect";

import { getErrorMessage } from "~/lib/workflow/errors";
import { WorkflowNodeAssetService } from "~/lib/workflow/services/node-services";
import { WorkflowClientService } from "~/lib/workflow/services/workflow-client";
import { WorkflowStudioStoreService } from "~/lib/workflow/services/workflow-studio-store-service";

export const WorkflowAssetService = {
  uploadFilesToNode(
    nodeId: string,
    files: File[],
    options: { kind: "image" | "video"; multiple: boolean },
  ) {
    return Effect.gen(function* () {
      const workflowStudioStore = yield* WorkflowStudioStoreService;

      yield* workflowStudioStore.setNodeRuntimeState(nodeId, "running", null);
      yield* workflowStudioStore.setActivity(
        `Uploading ${files.length} ${options.kind}${files.length === 1 ? "" : "s"}...`,
      );

      const uploadedAssets = yield* Effect.forEach(
        files,
        (file) => WorkflowClientService.uploadAsset(file),
        {
          concurrency: "unbounded",
        },
      );

      yield* workflowStudioStore.updateDocumentNode(nodeId, (node) =>
        WorkflowNodeAssetService.applyUploadedAssets(
          node,
          uploadedAssets.map((asset) => asset.asset),
          options,
        ),
      );
      yield* workflowStudioStore.setNodeRuntimeState(nodeId, "success", null);
      yield* workflowStudioStore.setActivity(
        `Uploaded ${uploadedAssets.length} ${options.kind}${uploadedAssets.length === 1 ? "" : "s"}.`,
      );
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const workflowStudioStore = yield* WorkflowStudioStoreService;
          const message = getErrorMessage(error);
          yield* workflowStudioStore.setNodeRuntimeState(
            nodeId,
            "error",
            message,
          );
          yield* workflowStudioStore.setActivity(message);
        }),
      ),
    );
  },
};
