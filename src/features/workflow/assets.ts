import { WorkflowValidationError } from "~/features/workflow/errors";
import type { MediaAssetKind, WorkflowAsset } from "~/features/workflow/types";

export const MAX_WORKFLOW_UPLOAD_BYTES = 128 * 1024 * 1024;
export const MAX_INLINE_ASSET_PREVIEW_BYTES = 24 * 1024 * 1024;

const SUPPORTED_IMAGE_UPLOAD_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

const SUPPORTED_VIDEO_UPLOAD_MIME_TYPES = ["video/mp4", "video/webm"] as const;

const SUPPORTED_WORKFLOW_UPLOAD_MIME_TYPES = new Set<string>([
  ...SUPPORTED_IMAGE_UPLOAD_MIME_TYPES,
  ...SUPPORTED_VIDEO_UPLOAD_MIME_TYPES,
]);

const INLINE_PREVIEWABLE_IMAGE_MIME_TYPES = new Set<string>(
  SUPPORTED_IMAGE_UPLOAD_MIME_TYPES,
);

const SUPPORTED_WORKFLOW_UPLOAD_FORMAT_LABEL =
  "JPG, PNG, WEBP, GIF, MP4, or WEBM";

export const WORKFLOW_IMAGE_UPLOAD_ACCEPT =
  SUPPORTED_IMAGE_UPLOAD_MIME_TYPES.join(",");
export const WORKFLOW_VIDEO_UPLOAD_ACCEPT =
  SUPPORTED_VIDEO_UPLOAD_MIME_TYPES.join(",");
export const WORKFLOW_ASSET_UPLOAD_ACCEPT = [
  WORKFLOW_IMAGE_UPLOAD_ACCEPT,
  WORKFLOW_VIDEO_UPLOAD_ACCEPT,
].join(",");

export function formatWorkflowAssetSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const rounded =
    value >= 10 || unitIndex === 0
      ? Math.round(value)
      : Math.round(value * 10) / 10;

  return `${rounded} ${units[unitIndex]}`;
}

export function getWorkflowUploadAssetKind(
  file: Pick<File, "type">,
): MediaAssetKind | null {
  if (!SUPPORTED_WORKFLOW_UPLOAD_MIME_TYPES.has(file.type)) {
    return null;
  }

  if (file.type.startsWith("image/")) {
    return "image";
  }

  if (file.type.startsWith("video/")) {
    return "video";
  }

  return null;
}

export function assertWorkflowUploadFile(file: Pick<File, "size" | "type">) {
  const kind = getWorkflowUploadAssetKind(file);
  if (!kind) {
    throw new WorkflowValidationError({
      message: `Supported upload formats: ${SUPPORTED_WORKFLOW_UPLOAD_FORMAT_LABEL}.`,
    });
  }

  if (file.size > MAX_WORKFLOW_UPLOAD_BYTES) {
    throw new WorkflowValidationError({
      message: `Uploads must be ${formatWorkflowAssetSize(MAX_WORKFLOW_UPLOAD_BYTES)} or smaller.`,
    });
  }

  return kind;
}

export function shouldInlineAssetPreview(
  asset: Pick<WorkflowAsset, "kind" | "mimeType" | "size">,
) {
  return (
    asset.kind === "image" &&
    INLINE_PREVIEWABLE_IMAGE_MIME_TYPES.has(asset.mimeType) &&
    asset.size <= MAX_INLINE_ASSET_PREVIEW_BYTES
  );
}
