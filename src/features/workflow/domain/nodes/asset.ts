import { z } from "zod";

const WorkflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const WorkflowAssetSchema = z.object({
  assetId: z.string().min(1),
  name: z.string().min(1).optional(),
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
