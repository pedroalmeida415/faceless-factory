import { Effect } from "effect";
import { getErrorMessage } from "~/lib/workflow/errors";
import { uploadAssetRequest } from "./requests";
import { setActivity, setNodeStatus } from "./state-effects";
import { WorkflowStudioStoreService } from "./store-service";

export const uploadFilesToNode = (
	nodeId: string,
	files: File[],
	options: { kind: "image" | "video"; multiple: boolean },
) =>
	Effect.gen(function* () {
		const workflowStudioStore = yield* WorkflowStudioStoreService;

		yield* setNodeStatus(nodeId, "running", null);
		yield* workflowStudioStore.setActivity(
			`Uploading ${files.length} ${options.kind}${files.length === 1 ? "" : "s"}...`,
		);

		const uploadedAssets = yield* Effect.forEach(files, uploadAssetRequest, {
			concurrency: "unbounded",
		});

		yield* workflowStudioStore.updateNodeData(nodeId, (current) => {
			switch (current.kind) {
				case "image":
					return {
						...current,
						asset: uploadedAssets[0]?.asset ?? null,
						status: "success",
						error: null,
					};
				case "video":
					return {
						...current,
						asset: uploadedAssets[0]?.asset ?? null,
						status: "success",
						error: null,
					};
				case "imageIterator":
					return {
						...current,
						assets: options.multiple
							? [
									...current.assets,
									...uploadedAssets.map((asset) => asset.asset),
								]
							: uploadedAssets.slice(0, 1).map((asset) => asset.asset),
						status: "success",
						error: null,
					};
				default:
					return current;
			}
		});

		yield* workflowStudioStore.setActivity(
			`Uploaded ${uploadedAssets.length} ${options.kind}${uploadedAssets.length === 1 ? "" : "s"}.`,
		);
	}).pipe(
		Effect.catchAll((error) =>
			Effect.all(
				[
					setNodeStatus(nodeId, "error", getErrorMessage(error)),
					setActivity(getErrorMessage(error)),
				],
				{ discard: true },
			).pipe(Effect.asVoid),
		),
	);
