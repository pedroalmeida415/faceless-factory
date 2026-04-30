import type { WorkflowAsset } from "~/lib/workflow/types";

export const WORKFLOW_ASSET_DND_KEY = "faceless-factory.workflow-asset";
export const WORKFLOW_ASSET_DND_TYPE = "workflow-asset";

export type WorkflowAssetDragData = {
  asset: WorkflowAsset;
  type: typeof WORKFLOW_ASSET_DND_TYPE;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkflowAsset(value: unknown): value is WorkflowAsset {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.kind === "image" ||
      value.kind === "video" ||
      value.kind === "text") &&
    (value.source === "upload" || value.source === "generated") &&
    typeof value.fileName === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.size === "number" &&
    typeof value.createdAt === "string" &&
    typeof value.url === "string" &&
    (value.storagePath === null || typeof value.storagePath === "string") &&
    (value.externalUri === null || typeof value.externalUri === "string") &&
    (value.model === null || typeof value.model === "string")
  );
}

function isWorkflowAssetDragData(
  value: unknown,
): value is WorkflowAssetDragData {
  return (
    isRecord(value) &&
    value.type === WORKFLOW_ASSET_DND_TYPE &&
    isWorkflowAsset(value.asset)
  );
}

export function getWorkflowAssetDragData(asset: WorkflowAsset) {
  return {
    [WORKFLOW_ASSET_DND_KEY]: {
      asset,
      type: WORKFLOW_ASSET_DND_TYPE,
    } satisfies WorkflowAssetDragData,
  };
}

export function getWorkflowAssetDropData(
  data: Record<string | symbol, unknown>,
) {
  const payload = data[WORKFLOW_ASSET_DND_KEY];
  return isWorkflowAssetDragData(payload) ? payload : null;
}
