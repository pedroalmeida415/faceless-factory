"use client";

import { Context, Effect, Layer } from "effect";
import { useWorkflowStudioStore } from "~/components/workflow/studio/store";
import type {
	WorkflowEdge,
	WorkflowNode,
} from "~/components/workflow/studio/types";
import type { WorkflowNodeData } from "~/lib/workflow/types";

export class WorkflowStudioStoreService extends Context.Tag(
	"WorkflowStudioStoreService",
)<
	WorkflowStudioStoreService,
	{
		readonly getGraphSnapshot: () => Effect.Effect<{
			nodes: WorkflowNode[];
			edges: WorkflowEdge[];
		}>;
		readonly setActivity: (activity: string) => Effect.Effect<void>;
		readonly updateNodeData: (
			nodeId: string,
			updater: (data: WorkflowNodeData) => WorkflowNodeData,
		) => Effect.Effect<void>;
	}
>() {
	static readonly functions = Effect.serviceFunctions(this);

	static readonly Live = Layer.succeed(this, {
		getGraphSnapshot: () =>
			Effect.sync(() => {
				const { edges, nodes } = useWorkflowStudioStore.getState();
				return { edges, nodes };
			}),
		setActivity: (activity) =>
			Effect.sync(() => {
				useWorkflowStudioStore.getState().setActivity(activity);
			}),
		updateNodeData: (nodeId, updater) =>
			Effect.sync(() => {
				useWorkflowStudioStore.getState().updateNodeData(nodeId, updater);
			}),
	});
}
