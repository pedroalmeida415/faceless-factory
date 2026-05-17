import type { WorkflowNode } from "~/features/workflow/domain/graph";
import { AssetNode } from "./asset-node";
import { ImageGenerationNode } from "./image-generation-node";
import { ListNode } from "./list-node";
import { PromptNode } from "./prompt-node";

export const workflowNodeTypes = {
  asset: AssetNode,
  imageGeneration: ImageGenerationNode,
  list: ListNode,
  prompt: PromptNode,
} satisfies Record<WorkflowNode["type"], (props: never) => React.ReactNode>;
