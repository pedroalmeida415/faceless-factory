import { Effect } from "effect";

import {
  getErrorMessage,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import { WorkflowNodeAssetService } from "~/lib/workflow/services/node-services";
import { WorkflowClientService } from "~/lib/workflow/services/workflow-client";
import { WorkflowStudioStoreService } from "~/lib/workflow/services/workflow-studio-store-service";
import type { AssetKind } from "~/lib/workflow/types";

function getFileAssetKind(file: File): AssetKind {
  if (file.type.startsWith("image/")) {
    return "image";
  }

  if (file.type.startsWith("video/")) {
    return "video";
  }

  throw new WorkflowValidationError({
    message: "Only image and video uploads are supported.",
  });
}

function getBatchAssetKind(files: File[]) {
  const firstKind = getFileAssetKind(files[0] as File);

  if (!files.every((file) => getFileAssetKind(file) === firstKind)) {
    throw new WorkflowValidationError({
      message: "Asset nodes only accept one media type at a time.",
    });
  }

  return firstKind;
}

export const WorkflowAssetService = {
  uploadFilesToNode(nodeId: string, files: File[]) {
    return Effect.gen(function* () {
      const workflowStudioStore = yield* WorkflowStudioStoreService;
      const snapshot = yield* workflowStudioStore.getWorkflowSnapshot();
      const node = snapshot.document.nodes.find(
        (candidate) => candidate.id === nodeId,
      );

      if (!node || node.kind !== "asset") {
        return yield* Effect.fail(
          new WorkflowValidationError({
            message: "Only asset nodes support uploads.",
          }),
        );
      }

      const batchKind = getBatchAssetKind(files);
      if (node.assetKind && node.assetKind !== batchKind) {
        return yield* Effect.fail(
          new WorkflowValidationError({
            message: `This asset node is locked to ${node.assetKind}s. Clear it before switching media type.`,
          }),
        );
      }

      yield* workflowStudioStore.setNodeRuntimeState(nodeId, "running", null);
      yield* workflowStudioStore.setActivity(
        `Uploading ${files.length} ${batchKind}${files.length === 1 ? "" : "s"}...`,
      );

      const uploadedAssets = yield* Effect.forEach(
        files,
        (file) => WorkflowClientService.uploadAsset(file),
        {
          concurrency: "unbounded",
        },
      );

      yield* workflowStudioStore.updateDocumentNode(nodeId, (currentNode) =>
        WorkflowNodeAssetService.applyUploadedAssets(
          currentNode,
          uploadedAssets.map((asset) => asset.asset),
        ),
      );
      yield* workflowStudioStore.setNodeRuntimeState(nodeId, "success", null);
      yield* workflowStudioStore.setActivity(
        `Uploaded ${uploadedAssets.length} ${batchKind}${uploadedAssets.length === 1 ? "" : "s"}.`,
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
