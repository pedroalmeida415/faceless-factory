import type {
  WorkflowDocument,
  WorkflowDocumentEdge,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { getWorkflowPlannedLaneCount } from "~/lib/workflow/execution/subgraph";
import {
  buildIncomingByTarget,
  getGeneratorInputHandles,
  getIncomingEdgesForHandle,
  getPromptNodeReferencedVariableKeys,
} from "~/lib/workflow/graph";
import { resolveLanePermutation } from "~/lib/workflow/lanes";
import {
  LANE_REORDER_INPUT_HANDLE_ID,
  LANE_TRANSFORM_INPUT_HANDLE_ID,
} from "~/lib/workflow/node-definitions";

export type WorkflowLaneIdentity = {
  nodeId: string;
  laneIndex: number;
};

export type WorkflowPlannedLaneJob = WorkflowLaneIdentity & {
  dependencies: WorkflowLaneIdentity[];
};

export type WorkflowLaneDependencyPlan = {
  jobs: WorkflowPlannedLaneJob[];
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

function laneKey(lane: WorkflowLaneIdentity) {
  return `${lane.nodeId}:${lane.laneIndex}`;
}

function uniqueLanes(lanes: readonly WorkflowLaneIdentity[]) {
  return Array.from(
    new Map(lanes.map((lane) => [laneKey(lane), lane] as const)).values(),
  ).sort(
    (left, right) =>
      left.nodeId.localeCompare(right.nodeId) ||
      left.laneIndex - right.laneIndex,
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

function getBroadcastSourceLane(params: {
  document: WorkflowDocument;
  generatorIterationById: ReadonlyMap<string, { iterations: number }>;
  laneIndex: number;
  sourceHandleId?: string | null;
  sourceNodeId: string;
}) {
  return getSourceLaneCount(params) === 1 ? 0 : params.laneIndex;
}

function getSourceLaneCount(params: {
  document: WorkflowDocument;
  generatorIterationById: ReadonlyMap<string, { iterations: number }>;
  sourceHandleId?: string | null;
  sourceNodeId: string;
}): number {
  return getWorkflowPlannedLaneCount(
    params.document,
    params.sourceNodeId,
    params.sourceHandleId,
    params.generatorIterationById,
  );
}

function getLaneMergeSource(params: {
  document: WorkflowDocument;
  generatorIterationById: ReadonlyMap<string, { iterations: number }>;
  incomingEdges: readonly WorkflowDocumentEdge[];
  laneIndex: number;
}) {
  let offset = 0;
  for (const edge of params.incomingEdges) {
    const laneCount = getSourceLaneCount({
      document: params.document,
      generatorIterationById: params.generatorIterationById,
      sourceHandleId: edge.sourceHandle,
      sourceNodeId: edge.source,
    });
    if (params.laneIndex < offset + laneCount) {
      return { edge, laneIndex: params.laneIndex - offset };
    }
    offset += laneCount;
  }

  return null;
}

function resolveSourceLaneDependencies(params: {
  document: WorkflowDocument;
  generatorIterationById: ReadonlyMap<string, { iterations: number }>;
  incomingByTarget: IncomingByTarget;
  laneIndex: number;
  nodeById: ReadonlyMap<string, WorkflowDocumentNode>;
  nodeId: string;
  sourceHandleId?: string | null;
  targetNodeIds: ReadonlySet<string>;
  visiting: ReadonlySet<string>;
}): WorkflowLaneIdentity[] {
  const visitKey = `${params.nodeId}:${params.sourceHandleId ?? ""}:${params.laneIndex}`;
  if (params.visiting.has(visitKey)) {
    return [];
  }

  const node = params.nodeById.get(params.nodeId);
  if (!node) {
    return [];
  }

  if (isGeneratorNode(node)) {
    return params.targetNodeIds.has(node.id)
      ? [{ nodeId: node.id, laneIndex: params.laneIndex }]
      : [];
  }

  const visiting = new Set(params.visiting).add(visitKey);
  const resolveEdge = (edge: WorkflowDocumentEdge, laneIndex: number) =>
    resolveSourceLaneDependencies({
      ...params,
      laneIndex,
      nodeId: edge.source,
      sourceHandleId: edge.sourceHandle,
      visiting,
    });

  switch (node.kind) {
    case "laneReorder": {
      const edge = getFirstInputEdge(
        params.incomingByTarget,
        node.id,
        LANE_REORDER_INPUT_HANDLE_ID,
      );
      if (!edge) {
        return [];
      }
      const laneOrder = resolveLanePermutation({
        laneCount: getSourceLaneCount({
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
        laneOrder[params.laneIndex] ??
          getBroadcastSourceLane({
            document: params.document,
            generatorIterationById: params.generatorIterationById,
            laneIndex: params.laneIndex,
            sourceHandleId: edge.sourceHandle,
            sourceNodeId: edge.source,
          }),
      );
    }
    case "laneSelect": {
      const edge = getFirstInputEdge(
        params.incomingByTarget,
        node.id,
        LANE_TRANSFORM_INPUT_HANDLE_ID,
      );
      return edge ? resolveEdge(edge, node.indices[params.laneIndex] ?? 0) : [];
    }
    case "laneSplit": {
      const edge = getFirstInputEdge(
        params.incomingByTarget,
        node.id,
        LANE_TRANSFORM_INPUT_HANDLE_ID,
      );
      const laneIndex = Number(
        (params.sourceHandleId ?? "lane-0").replace("lane-", ""),
      );
      return edge && Number.isInteger(laneIndex)
        ? resolveEdge(edge, laneIndex)
        : [];
    }
    case "laneMerge": {
      const source = getLaneMergeSource({
        document: params.document,
        generatorIterationById: params.generatorIterationById,
        incomingEdges: getIncomingEdgesForHandle(
          params.incomingByTarget,
          node.id,
          LANE_TRANSFORM_INPUT_HANDLE_ID,
        ),
        laneIndex: params.laneIndex,
      });
      return source ? resolveEdge(source.edge, source.laneIndex) : [];
    }
    case "laneZipAlign":
      return getIncomingEdgesForHandle(
        params.incomingByTarget,
        node.id,
        LANE_TRANSFORM_INPUT_HANDLE_ID,
      ).flatMap((edge) =>
        resolveEdge(
          edge,
          node.mode === "broadcast"
            ? getBroadcastSourceLane({
                document: params.document,
                generatorIterationById: params.generatorIterationById,
                laneIndex: params.laneIndex,
                sourceHandleId: edge.sourceHandle,
                sourceNodeId: edge.source,
              })
            : params.laneIndex,
        ),
      );
    case "prompt":
      return getPromptNodeReferencedVariableKeys(node).flatMap((key) =>
        getIncomingEdgesForHandle(
          params.incomingByTarget,
          node.id,
          key,
        ).flatMap((edge) =>
          resolveEdge(
            edge,
            getBroadcastSourceLane({
              document: params.document,
              generatorIterationById: params.generatorIterationById,
              laneIndex: params.laneIndex,
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

export function buildWorkflowLaneDependencyPlan(params: {
  document: WorkflowDocument;
  generatorIterationById: ReadonlyMap<string, { iterations: number }>;
  targetNodeIds: readonly string[];
}): WorkflowLaneDependencyPlan {
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

    return Array.from({ length: iterations }, (_, laneIndex) => ({
      dependencies: uniqueLanes(
        getGeneratorInputHandles(params.document, nodeId).flatMap((handle) =>
          getIncomingEdgesForHandle(
            incomingByTarget,
            nodeId,
            handle.id,
          ).flatMap((edge) =>
            resolveSourceLaneDependencies({
              document: params.document,
              generatorIterationById: params.generatorIterationById,
              incomingByTarget,
              laneIndex: getBroadcastSourceLane({
                document: params.document,
                generatorIterationById: params.generatorIterationById,
                laneIndex,
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
        (dependency) => laneKey(dependency) !== `${nodeId}:${laneIndex}`,
      ),
      laneIndex,
      nodeId,
    }));
  });

  return { jobs };
}

export function getReadyWorkflowLaneJobs(params: {
  blockedLanes?: ReadonlySet<string>;
  completedLanes: ReadonlySet<string>;
  plan: WorkflowLaneDependencyPlan;
}) {
  return params.plan.jobs.filter((job) => {
    const key = laneKey(job);
    return (
      !params.completedLanes.has(key) &&
      !params.blockedLanes?.has(key) &&
      job.dependencies.every((dependency) =>
        params.completedLanes.has(laneKey(dependency)),
      )
    );
  });
}

export function getWorkflowLaneKey(lane: WorkflowLaneIdentity) {
  return laneKey(lane);
}
