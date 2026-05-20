import { z } from "zod";
import { WorkflowAssetNodeSchema } from "~/features/workflow/domain/nodes/asset";
import { WorkflowImageGenerationNodeSchema } from "~/features/workflow/domain/nodes/image-generation";
import { WorkflowListNodeSchema } from "~/features/workflow/domain/nodes/list";
import { WorkflowPromptNodeSchema } from "~/features/workflow/domain/nodes/prompt";

export type { WorkflowAssetNode } from "~/features/workflow/domain/nodes/asset";
export type { WorkflowImageGenerationNode } from "~/features/workflow/domain/nodes/image-generation";
export type { WorkflowListNode } from "~/features/workflow/domain/nodes/list";
export type { WorkflowPromptNode } from "~/features/workflow/domain/nodes/prompt";

export const WORKFLOW_GRAPH_SCHEMA_VERSION = 1;

export const WorkflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
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

export const EMPTY_WORKFLOW_GRAPH = {
  edges: [],
  nodes: [],
  schemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION,
} satisfies WorkflowGraph;

export function createWorkflowGraph(draft: WorkflowGraphDraft): WorkflowGraph {
  return { ...draft, schemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION };
}

export function toPersistedWorkflowGraph(input: {
  readonly edges: readonly WorkflowEdge[];
  readonly nodes: readonly WorkflowNode[];
}): WorkflowGraphDraft {
  const nodeIds = new Set(input.nodes.map((node) => node.id));

  return {
    edges: input.edges
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .map((edge) => WorkflowEdgeSchema.parse(edge)),
    nodes: input.nodes.map((node) => WorkflowNodeSchema.parse(node)),
  };
}
