import { addEdge, type Connection, type EdgeChange, type NodeChange } from "@xyflow/react";
import { createStore } from "zustand/vanilla";
import {
  EMPTY_WORKFLOW_GRAPH,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowGraphDraft,
  type WorkflowNode,
} from "~/features/workflow/domain/graph";
import { createWorkflowNode, isWorkflowConnectionAllowed } from "~/features/workflow/domain/graph-editing";
import { getAppTrpcQueryUtils, getTrpcClient } from "~/main/trpc/react";

type WorkflowSaveState = "idle" | "saving" | "saved" | "error";

type WorkflowState = {
  readonly edges: WorkflowEdge[];
  readonly nodes: WorkflowNode[];
  readonly saveState: WorkflowSaveState;
  readonly selectedGenerationNodeId: string | null;
};

type WorkflowActions = {
  readonly addNodeToGraph: (type: WorkflowNode["type"]) => void;
  readonly closeNodeInspector: () => void;
  readonly onConnect: (connection: Connection) => void;
  readonly onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => void;
  readonly onNodesChange: (changes: NodeChange[]) => void;
  readonly selectNode: (nodeId: string, nodeType: WorkflowNode["type"]) => void;
  readonly dispose: () => void;
  readonly updateNode: (nodeId: string, updater: (node: WorkflowNode) => WorkflowNode) => void;
};

export type WorkflowStore = WorkflowState & WorkflowActions;

export type WorkflowStoreInitialState = {
  readonly graph?: WorkflowGraph;
  readonly selectedGenerationNodeId?: string | null;
};

export function createWorkflowStore(initialState: WorkflowStoreInitialState = {}, workflowId: string) {
  const utils = getAppTrpcQueryUtils();
  const trpcClient = getTrpcClient();
  const initialGraph = initialState.graph ?? EMPTY_WORKFLOW_GRAPH;

  return createStore<WorkflowStore>((set, get) => {
    let saveTimeout: ReturnType<typeof setTimeout> | null = null;

    const scheduleSave = (nextGraph: WorkflowGraphDraft) => {
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }

      set({ saveState: "saving" });
      saveTimeout = setTimeout(() => {
        void trpcClient.workflow.saveWorkflow
          .mutate({ graph: nextGraph, workflowId })
          .then(() => {
            set({ saveState: "saved" });
            void utils.workflow.getWorkflow.invalidate({ workflowId });
          })
          .catch(() => set({ saveState: "error" }));
      }, 700);
    };

    const commitGraph = (nextNodes: WorkflowNode[], nextEdges: WorkflowEdge[]) => {
      const nextGraph = { edges: nextEdges, nodes: nextNodes };
      set({ edges: nextEdges, nodes: nextNodes });
      scheduleSave(nextGraph);
    };

    return {
      edges: initialGraph.edges,
      nodes: initialGraph.nodes,
      saveState: "idle",
      selectedGenerationNodeId: initialState.selectedGenerationNodeId ?? null,
      addNodeToGraph: (type) => {
        const { edges, nodes } = get();
        const index = nodes.length;
        const id = `${type}-${crypto.randomUUID()}`;
        const position = { x: 0 + index * 48, y: 0 + index * 36 };
        commitGraph([...nodes, createWorkflowNode({ id, position, type })], edges);
      },
      closeNodeInspector: () => set({ selectedGenerationNodeId: null }),
      onConnect: (connection) => {
        const { edges, nodes } = get();

        if (!connection.source || !connection.target || !connection.targetHandle) {
          return;
        }

        if (!isWorkflowConnectionAllowed({ connection, edges, nodes })) {
          return;
        }

        commitGraph(nodes, addEdge({ ...connection, id: `edge-${crypto.randomUUID()}` }, edges));
      },
      onEdgesChange: (changes) => {
        const { edges, nodes } = get();
        const removedEdgeIds = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));

        if (removedEdgeIds.size === 0) {
          return;
        }

        commitGraph(
          nodes,
          edges.filter((edge) => !removedEdgeIds.has(edge.id)),
        );
      },
      onNodesChange: (changes) => {
        const { edges, nodes } = get();
        const positionChanges = changes.flatMap((change) =>
          change.type === "position" && change.position ? [{ id: change.id, position: change.position }] : [],
        );
        const removedNodeIds = new Set(changes.flatMap((change) => (change.type === "remove" ? [change.id] : [])));
        const selectedGenerationNodeId = get().selectedGenerationNodeId;
        const selectedNodeLostFocus = changes.some(
          (change) => change.type === "select" && change.id === selectedGenerationNodeId && !change.selected,
        );

        if (selectedNodeLostFocus) {
          set({ selectedGenerationNodeId: null });
        }

        if (positionChanges.length === 0 && removedNodeIds.size === 0) {
          return;
        }

        commitGraph(
          nodes
            .filter((node) => !removedNodeIds.has(node.id))
            .map((node) => {
              const positionChange = positionChanges.find((change) => change.id === node.id);

              return positionChange ? { ...node, position: positionChange.position } : node;
            }),
          edges.filter((edge) => !removedNodeIds.has(edge.source) && !removedNodeIds.has(edge.target)),
        );
      },
      selectNode: (nodeId, nodeType) => {
        set({ selectedGenerationNodeId: nodeType === "imageGeneration" ? nodeId : null });
      },
      dispose: () => {
        if (saveTimeout) {
          clearTimeout(saveTimeout);
          saveTimeout = null;
        }
      },
      updateNode: (nodeId, updater) => {
        const { edges, nodes } = get();
        commitGraph(
          nodes.map((node) => (node.id === nodeId ? updater(node) : node)),
          edges,
        );
      },
    };
  });
}
