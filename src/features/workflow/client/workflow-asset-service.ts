import { Effect } from "effect";

import { assertWorkflowUploadFile } from "~/features/workflow/assets";
import { WorkflowClientService } from "~/features/workflow/client/workflow-client";
import { WorkflowStudioStoreService } from "~/features/workflow/client/workflow-studio-store-service";
import {
  getErrorMessage,
  WorkflowValidationError,
} from "~/features/workflow/errors";
import { WorkflowNodeAssetService } from "~/features/workflow/node-operations";

function getBatchAssetKind(files: File[]) {
  const firstKind = assertWorkflowUploadFile(files[0] as File);

  if (!files.every((file) => assertWorkflowUploadFile(file) === firstKind)) {
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
      const projectId = snapshot.projectId;
      const node = snapshot.document.nodes.find(
        (candidate) => candidate.id === nodeId,
      );

      if (!projectId) {
        return yield* Effect.fail(
          new WorkflowValidationError({
            message: "Workflow project is not ready yet.",
          }),
        );
      }

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
        (file) => WorkflowClientService.uploadAsset(file, projectId),
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
