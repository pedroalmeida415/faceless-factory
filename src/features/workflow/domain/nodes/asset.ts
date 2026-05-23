import { z } from "zod";
import type { WorkflowDataType } from "~/features/workflow/domain/model-catalog";

const WorkflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const WorkflowAssetSchema = z.object({
  assetId: z.string().min(1),
  durationSeconds: z.number().nonnegative().optional(),
  height: z.number().int().positive().optional(),
  mediaType: z.enum(["image", "video", "audio"]).optional(),
  mimeType: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  previewUrl: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
});

export const WorkflowAssetNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("asset"),
  position: WorkflowPositionSchema,
  data: z.object({
    assets: z.array(WorkflowAssetSchema),
  }),
});

export type WorkflowAssetNode = z.infer<typeof WorkflowAssetNodeSchema>;

export function createDefaultWorkflowAssetNodeData(): WorkflowAssetNode["data"] {
  return { assets: [] };
}

export function getWorkflowAssetIds(node: WorkflowAssetNode) {
  return node.data.assets.map((asset) => asset.assetId);
}

export function getWorkflowAssetNodeDataType(node: WorkflowAssetNode): WorkflowDataType | null {
  const asset = node.data.assets[0];

  if (!asset) {
    return null;
  }

  return asset.mediaType ?? "image";
}
