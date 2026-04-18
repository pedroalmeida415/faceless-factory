import { Effect } from "effect";
import type { WorkflowNodeData } from "~/lib/workflow/types";
import { WorkflowStudioStoreService } from "./store-service";

export const setNodeStatus = (
	nodeId: string,
	status: WorkflowNodeData["status"],
	error: string | null,
) =>
	Effect.gen(function* () {
		const workflowStudioStore = yield* WorkflowStudioStoreService;
		yield* workflowStudioStore.updateNodeData(nodeId, (current) => ({
			...current,
			status,
			error,
		}));
	});

export const setActivity = (activity: string) =>
	Effect.gen(function* () {
		const workflowStudioStore = yield* WorkflowStudioStoreService;
		yield* workflowStudioStore.setActivity(activity);
	});
