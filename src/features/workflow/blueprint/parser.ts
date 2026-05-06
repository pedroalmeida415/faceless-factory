import type { WorkflowDocument } from "~/features/workflow/document";
import {
  buildIncomingByTarget,
  buildOutgoingBySource,
  isValidWorkflowEdge,
} from "~/features/workflow/graph";

export type WorkflowBlueprintValidationError = {
  readonly _tag: "WorkflowBlueprintValidationError";
  readonly message: string;
};

export type WorkflowBlueprintResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WorkflowBlueprintValidationError };

export type WorkflowDependencyAddress = {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly sourceHandle: string | null;
  readonly targetHandle: string | null;
};

export type WorkflowBlueprint = {
  readonly getChildNodeIds: (
    nodeId: string,
  ) => WorkflowBlueprintResult<readonly string[]>;
  readonly getDownstreamClosureNodeIds: (
    nodeId: string,
  ) => WorkflowBlueprintResult<readonly string[]>;
  readonly getParentNodeIds: (
    nodeId: string,
  ) => WorkflowBlueprintResult<readonly string[]>;
  readonly getParentDependencyAddresses: (
    nodeId: string,
  ) => WorkflowBlueprintResult<readonly WorkflowDependencyAddress[]>;
  readonly getUpstreamClosureNodeIds: (
    nodeId: string,
  ) => WorkflowBlueprintResult<readonly string[]>;
};

function ok<T>(value: T): WorkflowBlueprintResult<T> {
  return { ok: true, value };
}

function validationError<T>(message: string): WorkflowBlueprintResult<T> {
  return {
    error: { _tag: "WorkflowBlueprintValidationError", message },
    ok: false,
  };
}

function sortedUnique(ids: Iterable<string>) {
  return Array.from(new Set(ids)).sort((left, right) =>
    left.localeCompare(right),
  );
}

function compareDependencyAddress(
  left: WorkflowDependencyAddress,
  right: WorkflowDependencyAddress,
) {
  return (
    left.sourceNodeId.localeCompare(right.sourceNodeId) ||
    (left.sourceHandle ?? "").localeCompare(right.sourceHandle ?? "") ||
    left.targetNodeId.localeCompare(right.targetNodeId) ||
    (left.targetHandle ?? "").localeCompare(right.targetHandle ?? "")
  );
}

function validateDocument(
  document: WorkflowDocument,
): WorkflowBlueprintResult<Set<string>> {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const connectionKeys = new Set<string>();

  for (const node of document.nodes) {
    if (nodeIds.has(node.id)) {
      return validationError(`Duplicate node id: ${node.id}.`);
    }
    nodeIds.add(node.id);
  }

  for (const edge of document.edges) {
    if (edgeIds.has(edge.id)) {
      return validationError(`Duplicate edge id: ${edge.id}.`);
    }
    edgeIds.add(edge.id);

    const connectionKey = [
      edge.source,
      edge.sourceHandle ?? "",
      edge.target,
      edge.targetHandle ?? "",
    ].join("::");

    if (connectionKeys.has(connectionKey)) {
      return validationError(
        "Workflow blueprint contains a duplicate dependency address.",
      );
    }
    connectionKeys.add(connectionKey);

    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      return validationError(
        "Workflow blueprint contains a dependency address to a missing node.",
      );
    }

    if (!isValidWorkflowEdge(document, edge)) {
      return validationError(
        "Workflow blueprint contains an invalid dependency address.",
      );
    }
  }

  const acyclic = topologicalOrder({ edges: document.edges, nodeIds });
  if (!acyclic.ok) {
    return acyclic;
  }

  return ok(nodeIds);
}

function collectReachableNodeIds(params: {
  readonly adjacentByNode: ReadonlyMap<string, readonly { target: string }[]>;
  readonly nodeId: string;
}) {
  const reachable = new Set<string>();
  const queue = sortedUnique(
    (params.adjacentByNode.get(params.nodeId) ?? []).map((edge) => edge.target),
  );

  while (queue.length) {
    const nextId = queue.shift();
    if (!nextId || reachable.has(nextId)) {
      continue;
    }

    reachable.add(nextId);
    queue.push(
      ...sortedUnique(
        (params.adjacentByNode.get(nextId) ?? []).map((edge) => edge.target),
      ),
    );
  }

  return reachable;
}

function topologicalOrder(params: {
  readonly edges: readonly { source: string; target: string }[];
  readonly nodeIds: ReadonlySet<string>;
}): WorkflowBlueprintResult<string[]> {
  const outgoingBySource = new Map<string, string[]>();
  const incomingCountByNode = new Map<string, number>();

  for (const nodeId of params.nodeIds) {
    incomingCountByNode.set(nodeId, 0);
  }

  const dependencyEdges = new Set<string>();
  for (const edge of params.edges) {
    if (!params.nodeIds.has(edge.source) || !params.nodeIds.has(edge.target)) {
      continue;
    }

    const dependencyEdge = `${edge.source}\0${edge.target}`;
    if (dependencyEdges.has(dependencyEdge)) {
      continue;
    }
    dependencyEdges.add(dependencyEdge);

    outgoingBySource.set(edge.source, [
      ...(outgoingBySource.get(edge.source) ?? []),
      edge.target,
    ]);
    incomingCountByNode.set(
      edge.target,
      (incomingCountByNode.get(edge.target) ?? 0) + 1,
    );
  }

  const ready = sortedUnique(
    Array.from(incomingCountByNode)
      .filter(([, count]) => count === 0)
      .map(([nodeId]) => nodeId),
  );
  const ordered: string[] = [];

  while (ready.length) {
    const nodeId = ready.shift();
    if (!nodeId) {
      continue;
    }

    ordered.push(nodeId);
    for (const childId of sortedUnique(outgoingBySource.get(nodeId) ?? [])) {
      const incomingCount = (incomingCountByNode.get(childId) ?? 0) - 1;
      incomingCountByNode.set(childId, incomingCount);
      if (incomingCount === 0) {
        ready.push(childId);
        ready.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  return ordered.length === params.nodeIds.size
    ? ok(ordered)
    : validationError("Workflow blueprint contains a dependency cycle.");
}

export function parseWorkflowBlueprint(
  document: WorkflowDocument,
): WorkflowBlueprintResult<WorkflowBlueprint> {
  const validation = validateDocument(document);
  if (!validation.ok) {
    return validation;
  }

  const nodeIds = validation.value;
  const incomingByTarget = buildIncomingByTarget(document.edges);
  const outgoingBySource = buildOutgoingBySource(document.edges);

  const requireNode = (nodeId: string) =>
    nodeIds.has(nodeId)
      ? ok(nodeId)
      : validationError<string>(
          `Workflow blueprint is missing node ${nodeId}.`,
        );

  return ok({
    getChildNodeIds(nodeId) {
      const node = requireNode(nodeId);
      if (!node.ok) {
        return node;
      }

      return ok(
        sortedUnique(
          (outgoingBySource.get(nodeId) ?? []).map((edge) => edge.target),
        ),
      );
    },

    getDownstreamClosureNodeIds(nodeId) {
      const node = requireNode(nodeId);
      if (!node.ok) {
        return node;
      }

      const closureNodeIds = collectReachableNodeIds({
        adjacentByNode: outgoingBySource,
        nodeId,
      });
      return topologicalOrder({
        edges: document.edges,
        nodeIds: closureNodeIds,
      });
    },

    getParentNodeIds(nodeId) {
      const node = requireNode(nodeId);
      if (!node.ok) {
        return node;
      }

      return ok(
        sortedUnique(
          (incomingByTarget.get(nodeId) ?? []).map((edge) => edge.source),
        ),
      );
    },

    getParentDependencyAddresses(nodeId) {
      const node = requireNode(nodeId);
      if (!node.ok) {
        return node;
      }

      return ok(
        (incomingByTarget.get(nodeId) ?? [])
          .map((edge) => ({
            sourceHandle: edge.sourceHandle,
            sourceNodeId: edge.source,
            targetHandle: edge.targetHandle,
            targetNodeId: edge.target,
          }))
          .sort(compareDependencyAddress),
      );
    },

    getUpstreamClosureNodeIds(nodeId) {
      const node = requireNode(nodeId);
      if (!node.ok) {
        return node;
      }

      const reversedIncomingByTarget = new Map(
        Array.from(incomingByTarget, ([target, edges]) => [
          target,
          edges.map((edge) => ({ source: edge.target, target: edge.source })),
        ]),
      );
      const closureNodeIds = collectReachableNodeIds({
        adjacentByNode: reversedIncomingByTarget,
        nodeId,
      });
      return topologicalOrder({
        edges: document.edges,
        nodeIds: closureNodeIds,
      });
    },
  });
}
