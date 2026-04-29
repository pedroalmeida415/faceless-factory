import type {
  WorkflowDocument,
  WorkflowDocumentEdge,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { getWorkflowVisibleCompletionOutputs } from "~/lib/workflow/execution/artifact-projection";
import { getWorkflowPlannedOutputCount } from "~/lib/workflow/execution/subgraph";
import {
  getErroredWorkflowOutputResults,
  getWorkflowOutputKey,
  type WorkflowOutputArtifacts,
} from "~/lib/workflow/execution/types";
import {
  buildIncomingByTarget,
  getGeneratorInputHandles,
  getIncomingEdgesForHandle,
  getPromptNodeReferencedVariableKeys,
} from "~/lib/workflow/graph";
import { OUTPUT_REORDER_INPUT_HANDLE_ID } from "~/lib/workflow/node-definitions";
import { resolveOutputPermutation } from "~/lib/workflow/runtime-values";

export type WorkflowOutputIdentity = {
  nodeId: string;
  outputIndex: number;
};

export type WorkflowPlannedOutputJob = WorkflowOutputIdentity & {
  dependencies: WorkflowOutputIdentity[];
};

export type WorkflowOutputDependencyPlan = {
  jobs: WorkflowPlannedOutputJob[];
};

type IncomingByTarget = ReturnType<typeof buildIncomingByTarget>;

function isGeneratorNode(
  node: WorkflowDocumentNode | undefined,
): node is Extract<
  WorkflowDocumentNode,
  { kind: "imageGenerator" | "videoGenerator" | "llmGenerator" }
> {
  return (
    node?.kind === "imageGenerator" ||
    node?.kind === "videoGenerator" ||
    node?.kind === "llmGenerator"
  );
}

function uniqueOutputs(items: readonly WorkflowOutputIdentity[]) {
  return Array.from(
    new Map(
      items.map((output) => [getWorkflowOutputKey(output), output] as const),
    ).values(),
  ).sort(
    (left, right) =>
      left.nodeId.localeCompare(right.nodeId) ||
      left.outputIndex - right.outputIndex,
  );
}

function getFirstInputEdge(
  incomingByTarget: IncomingByTarget,
  nodeId: string,
  handleId: string,
) {
  return (
    getIncomingEdgesForHandle(incomingByTarget, nodeId, handleId)[0] ?? null
  );
}

function getBroadcastSourceOutput(params: {
  document: WorkflowDocument;
  generatorIterationById: ReadonlyMap<string, { iterations: number }>;
  outputIndex: number;
  sourceHandleId?: string | null;
  sourceNodeId: string;
}) {
  return getSourceOutputCount(params) === 1 ? 0 : params.outputIndex;
}

function getSourceOutputCount(params: {
  document: WorkflowDocument;
  generatorIterationById: ReadonlyMap<string, { iterations: number }>;
  sourceHandleId?: string | null;
  sourceNodeId: string;
}): number {
  return getWorkflowPlannedOutputCount(
    params.document,
    params.sourceNodeId,
    params.sourceHandleId,
    params.generatorIterationById,
  );
}

function resolveSourceOutputDependencies(params: {
  document: WorkflowDocument;
  generatorIterationById: ReadonlyMap<string, { iterations: number }>;
  incomingByTarget: IncomingByTarget;
  outputIndex: number;
  nodeById: ReadonlyMap<string, WorkflowDocumentNode>;
  nodeId: string;
  sourceHandleId?: string | null;
  targetNodeIds: ReadonlySet<string>;
  visiting: ReadonlySet<string>;
}): WorkflowOutputIdentity[] {
  const visitKey = `${params.nodeId}:${params.sourceHandleId ?? ""}:${params.outputIndex}`;
  if (params.visiting.has(visitKey)) {
    return [];
  }

  const node = params.nodeById.get(params.nodeId);
  if (!node) {
    return [];
  }

  if (isGeneratorNode(node)) {
    return [{ nodeId: node.id, outputIndex: params.outputIndex }];
  }

  const visiting = new Set(params.visiting).add(visitKey);
  const resolveEdge = (edge: WorkflowDocumentEdge, outputIndex: number) =>
    resolveSourceOutputDependencies({
      ...params,
      outputIndex,
      nodeId: edge.source,
      sourceHandleId: edge.sourceHandle,
      visiting,
    });

  switch (node.kind) {
    case "outputReorder": {
      const edge = getFirstInputEdge(
        params.incomingByTarget,
        node.id,
        OUTPUT_REORDER_INPUT_HANDLE_ID,
      );
      if (!edge) {
        return [];
      }
      const outputOrder = resolveOutputPermutation({
        outputCount: getSourceOutputCount({
          document: params.document,
          generatorIterationById: params.generatorIterationById,
          sourceHandleId: edge.sourceHandle,
          sourceNodeId: edge.source,
        }),
        mode: node.mode,
        order: node.order,
        shift: node.shift,
      });
      return resolveEdge(
        edge,
        outputOrder[params.outputIndex] ??
          getBroadcastSourceOutput({
            document: params.document,
            generatorIterationById: params.generatorIterationById,
            outputIndex: params.outputIndex,
            sourceHandleId: edge.sourceHandle,
            sourceNodeId: edge.source,
          }),
      );
    }
    case "prompt":
      return getPromptNodeReferencedVariableKeys(node).flatMap((key) =>
        getIncomingEdgesForHandle(
          params.incomingByTarget,
          node.id,
          key,
        ).flatMap((edge) =>
          resolveEdge(
            edge,
            getBroadcastSourceOutput({
              document: params.document,
              generatorIterationById: params.generatorIterationById,
              outputIndex: params.outputIndex,
              sourceHandleId: edge.sourceHandle,
              sourceNodeId: edge.source,
            }),
          ),
        ),
      );
    case "asset":
    case "list":
      return [];
  }
}

export function buildWorkflowOutputDependencyPlan(params: {
  document: WorkflowDocument;
  generatorIterationById: ReadonlyMap<string, { iterations: number }>;
  targetNodeIds: readonly string[];
}): WorkflowOutputDependencyPlan {
  const incomingByTarget = buildIncomingByTarget(params.document.edges);
  const nodeById = new Map(
    params.document.nodes.map((node) => [node.id, node]),
  );
  const targetNodeIds = new Set(params.targetNodeIds);
  const jobs = params.targetNodeIds.flatMap((nodeId) => {
    const node = nodeById.get(nodeId);
    const iterations =
      params.generatorIterationById.get(nodeId)?.iterations ?? 1;
    if (!isGeneratorNode(node)) {
      return [];
    }

    return Array.from({ length: iterations }, (_, outputIndex) => ({
      dependencies: uniqueOutputs(
        getGeneratorInputHandles(params.document, nodeId).flatMap((handle) =>
          getIncomingEdgesForHandle(
            incomingByTarget,
            nodeId,
            handle.id,
          ).flatMap((edge) =>
            resolveSourceOutputDependencies({
              document: params.document,
              generatorIterationById: params.generatorIterationById,
              incomingByTarget,
              outputIndex: getBroadcastSourceOutput({
                document: params.document,
                generatorIterationById: params.generatorIterationById,
                outputIndex,
                sourceHandleId: edge.sourceHandle,
                sourceNodeId: edge.source,
              }),
              nodeById,
              nodeId: edge.source,
              sourceHandleId: edge.sourceHandle,
              targetNodeIds,
              visiting: new Set(),
            }),
          ),
        ),
      ).filter(
        (dependency) =>
          getWorkflowOutputKey(dependency) !== `${nodeId}:${outputIndex}`,
      ),
      outputIndex,
      nodeId,
    }));
  });

  return { jobs };
}

export function getReadyWorkflowOutputJobs(params: {
  blockedOutputs?: ReadonlySet<string>;
  completedOutputs: ReadonlySet<string>;
  plan: WorkflowOutputDependencyPlan;
}) {
  return params.plan.jobs.filter((job) => {
    const key = getWorkflowOutputKey(job);
    return (
      !params.completedOutputs.has(key) &&
      !params.blockedOutputs?.has(key) &&
      job.dependencies.every((dependency) =>
        params.completedOutputs.has(getWorkflowOutputKey(dependency)),
      )
    );
  });
}

export function getCompletedWorkflowOutputKeys(
  artifacts: WorkflowOutputArtifacts,
) {
  return new Set(
    getWorkflowVisibleCompletionOutputs(artifacts).map(getWorkflowOutputKey),
  );
}

export function getFailedWorkflowOutputKeys(
  artifacts: WorkflowOutputArtifacts,
) {
  return new Set(
    getErroredWorkflowOutputResults(artifacts).map(getWorkflowOutputKey),
  );
}

export function getFailedWorkflowOutputClosure(params: {
  failedOutputs: ReadonlySet<string>;
  plan: WorkflowOutputDependencyPlan;
}) {
  const failedOutputs = new Set(params.failedOutputs);
  let changed = true;

  while (changed) {
    changed = false;
    for (const job of params.plan.jobs) {
      const key = getWorkflowOutputKey(job);
      if (failedOutputs.has(key)) {
        continue;
      }
      if (
        job.dependencies.some((dependency) =>
          failedOutputs.has(getWorkflowOutputKey(dependency)),
        )
      ) {
        failedOutputs.add(key);
        changed = true;
      }
    }
  }

  return failedOutputs;
}

export function areWorkflowOutputJobsSettled(params: {
  completedOutputs: ReadonlySet<string>;
  failedOutputs: ReadonlySet<string>;
  plan: WorkflowOutputDependencyPlan;
}) {
  const failedClosure = getFailedWorkflowOutputClosure(params);
  return params.plan.jobs.every((job) => {
    const key = getWorkflowOutputKey(job);
    return params.completedOutputs.has(key) || failedClosure.has(key);
  });
}

export function getWorkflowOutputSettlement(params: {
  artifacts: WorkflowOutputArtifacts;
  blockedOutputs?: ReadonlySet<string>;
  plan: WorkflowOutputDependencyPlan;
}) {
  const completedOutputs = getCompletedWorkflowOutputKeys(params.artifacts);
  const failedOutputs = getFailedWorkflowOutputKeys(params.artifacts);
  const failedClosure = getFailedWorkflowOutputClosure({
    failedOutputs,
    plan: params.plan,
  });
  const blockedOutputs = new Set(params.blockedOutputs ?? []);
  for (const key of failedClosure) {
    blockedOutputs.add(key);
  }

  return {
    blockedOutputs,
    completedOutputs,
    failedClosure,
    failedOutputs,
    plan: params.plan,
    settled: params.plan.jobs.every((job) => {
      const key = getWorkflowOutputKey(job);
      return completedOutputs.has(key) || failedClosure.has(key);
    }),
  };
}

export { getWorkflowOutputKey } from "~/lib/workflow/execution/types";
