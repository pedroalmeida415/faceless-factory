import { z } from "zod";
import { NANO_BANANA_PRO_MODEL, WorkflowConfigSchema } from "~/features/workflow/domain/model-catalog";

const WorkflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const WorkflowSelectedBatchItemSchema = z.object({
  batchItemId: z.string().min(1),
  branchIndex: z.number().int().nonnegative(),
});

export const WorkflowImageGenerationNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("imageGeneration"),
  position: WorkflowPositionSchema,
  data: z.object({
    branchBatchSize: z.number().int().min(1),
    config: WorkflowConfigSchema,
    modelId: z.string().min(1),
    selectedBatchItems: z.array(WorkflowSelectedBatchItemSchema),
  }),
});

export type WorkflowImageGenerationNode = z.infer<typeof WorkflowImageGenerationNodeSchema>;

export function createDefaultWorkflowImageGenerationNodeData(): WorkflowImageGenerationNode["data"] {
  return {
    branchBatchSize: 1,
    config: NANO_BANANA_PRO_MODEL.defaultConfig,
    modelId: NANO_BANANA_PRO_MODEL.modelId,
    selectedBatchItems: [],
  };
}

export function getSortedWorkflowSelectedBatchItems(node: WorkflowImageGenerationNode) {
  return [...node.data.selectedBatchItems].sort((left, right) => left.branchIndex - right.branchIndex);
}
