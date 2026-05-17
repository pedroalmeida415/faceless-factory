import { z } from "zod";

export const WORKFLOW_GRAPH_SCHEMA_VERSION = 1;

export const WorkflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const WorkflowConfigValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const WorkflowConfigSchema = z.record(z.string(), WorkflowConfigValueSchema);

export const WorkflowAssetSchema = z.object({
  assetId: z.string().min(1),
  name: z.string().min(1).optional(),
});

export const WorkflowPromptNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("prompt"),
  position: WorkflowPositionSchema,
  data: z.object({
    text: z.string(),
  }),
});

export const WorkflowListNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("list"),
  position: WorkflowPositionSchema,
  data: z.object({
    items: z.array(
      z.object({
        id: z.string().min(1),
        text: z.string(),
      }),
    ),
  }),
});

export const WorkflowAssetNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("asset"),
  position: WorkflowPositionSchema,
  data: z.object({
    assets: z.array(WorkflowAssetSchema),
  }),
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

export const WorkflowNodeSchema = z.discriminatedUnion("type", [
  WorkflowPromptNodeSchema,
  WorkflowListNodeSchema,
  WorkflowAssetNodeSchema,
  WorkflowImageGenerationNodeSchema,
]);

export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().min(1).optional(),
  target: z.string().min(1),
  targetHandle: z.string().min(1).optional(),
});

export const WorkflowGraphSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_GRAPH_SCHEMA_VERSION),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
});

export const WorkflowGraphDraftSchema = z.object({
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
});

export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;
export type WorkflowGraphDraft = z.infer<typeof WorkflowGraphDraftSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowPromptNode = z.infer<typeof WorkflowPromptNodeSchema>;
export type WorkflowListNode = z.infer<typeof WorkflowListNodeSchema>;
export type WorkflowAssetNode = z.infer<typeof WorkflowAssetNodeSchema>;
export type WorkflowImageGenerationNode = z.infer<typeof WorkflowImageGenerationNodeSchema>;

export const EMPTY_WORKFLOW_GRAPH = {
  edges: [],
  nodes: [],
  schemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION,
} satisfies WorkflowGraph;

export function createWorkflowGraph(draft: WorkflowGraphDraft): WorkflowGraph {
  return { ...draft, schemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION };
}
