import { Deferred, Effect } from "effect";
import type { RuntimeValue } from "~/components/workflow/studio/graph";
import { getErrorMessage, WorkflowExecutionError } from "~/lib/workflow/errors";
import type { WorkflowNodeData } from "~/lib/workflow/types";
import { executeNode } from "./node-execution";
import type {
	ClientWorkflowError,
	EvaluateNode,
	IncomingByTarget,
	NodeMap,
	PendingMap,
	RunnerRequirements,
} from "./shared";
import { setNodeStatus } from "./state-effects";

export const evaluateNode = (
	currentId: string,
	path: ReadonlySet<string>,
	nodeMap: NodeMap,
	incomingByTarget: IncomingByTarget,
	pending: PendingMap,
): Effect.Effect<RuntimeValue, ClientWorkflowError, RunnerRequirements> =>
	Effect.suspend(() => {
		if (path.has(currentId)) {
			return Effect.fail(
				new WorkflowExecutionError({
					message: "Cycle detected in workflow graph.",
				}),
			);
		}

		const cached = pending.get(currentId);
		if (cached) {
			return Deferred.await(cached);
		}

		const recursiveEvaluateNode: EvaluateNode = (nextId, nextPath) =>
			evaluateNode(nextId, nextPath, nodeMap, incomingByTarget, pending);

		return Effect.gen(function* () {
			const deferred = yield* Deferred.make<
				RuntimeValue,
				ClientWorkflowError
			>();
			pending.set(currentId, deferred);

			const nextPath = new Set(path);
			nextPath.add(currentId);

			const exit = yield* Effect.exit(
				Effect.gen(function* () {
					const currentNode = nodeMap.get(currentId);
					if (!currentNode) {
						return yield* Effect.fail(
							new WorkflowExecutionError({
								message: `Node ${currentId} not found.`,
							}),
						);
					}

					const data = currentNode.data as WorkflowNodeData;
					return yield* executeNode(
						currentId,
						data,
						nextPath,
						incomingByTarget,
						recursiveEvaluateNode,
					);
				}).pipe(
					Effect.tapError((error) =>
						setNodeStatus(currentId, "error", getErrorMessage(error)),
					),
				),
			);

			yield* Deferred.done(deferred, exit);
			return yield* Deferred.await(deferred);
		});
	});
