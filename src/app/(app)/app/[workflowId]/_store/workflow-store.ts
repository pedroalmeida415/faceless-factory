import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeOrigin,
} from "@xyflow/react";
import { setAutoFreeze } from "immer";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { createStore, type Mutate, type StoreApi } from "zustand/vanilla";
import {
  EMPTY_WORKFLOW_GRAPH,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from "~/features/workflow/domain/graph";
import { createWorkflowNode, isWorkflowConnectionAllowed } from "~/features/workflow/domain/graph-editing";

type WorkflowSaveState = "idle" | "saving" | "saved" | "error";
type WorkflowNodePosition = WorkflowNode["position"];
type CenteringWorkflowNode = WorkflowNode & { readonly origin?: NodeOrigin };
const CENTERED_NODE_ORIGIN = [0.5, 0.5] satisfies NodeOrigin;

setAutoFreeze(false);

type WorkflowState = {
  readonly edges: WorkflowEdge[];
  readonly nodes: WorkflowNode[];
  readonly saveState: WorkflowSaveState;
  readonly selectedNodeId: string | null;
};

type WorkflowActions = {
  readonly addNodeToGraph: (input: {
    readonly position: WorkflowNodePosition;
    readonly type: WorkflowNode["type"];
  }) => string;
  readonly closeNodeInspector: () => void;
  readonly onConnect: (connection: Connection) => void;
  readonly onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => void;
  readonly onNodesChange: (changes: NodeChange<WorkflowNode>[]) => void;
  readonly selectNode: (nodeId: string) => void;
  readonly setSaveState: (saveState: WorkflowSaveState) => void;
  readonly updateNodeData: <TNode extends WorkflowNode>(nodeId: string, data: TNode["data"]) => void;
};

export type WorkflowStore = WorkflowState & WorkflowActions;
export type WorkflowStoreApi = Mutate<
  StoreApi<WorkflowStore>,
  [["zustand/subscribeWithSelector", never], ["zustand/immer", never]]
>;

export type WorkflowStoreInitialState = {
  readonly graph?: WorkflowGraph;
  readonly selectedNodeId?: string | null;
};

export function createWorkflowStore(initialState: WorkflowStoreInitialState = {}) {
  const initialGraph = initialState.graph ?? EMPTY_WORKFLOW_GRAPH;

  return createStore<WorkflowStore>()(
    subscribeWithSelector(
      immer((set, get) => ({
        edges: initialGraph.edges,
        nodes: initialGraph.nodes,
        saveState: "idle",
        selectedNodeId: initialState.selectedNodeId ?? null,
        addNodeToGraph: ({ position, type }) => {
          const node = createWorkflowNode({ position, type });
          const centeredNode = { ...node, origin: CENTERED_NODE_ORIGIN };

          set((state) => {
            state.nodes.push(centeredNode);
          });

          return node.id;
        },
        closeNodeInspector: () =>
          set((state) => {
            state.selectedNodeId = null;
          }),
        onConnect: (connection) => {
          const { edges, nodes } = get();

          if (!connection.source || !connection.target || !connection.targetHandle) {
            return;
          }

          if (!isWorkflowConnectionAllowed({ connection, edges, nodes })) {
            return;
          }

          set((state) => {
            state.edges = addEdge({ ...connection, id: `edge-${crypto.randomUUID()}` }, edges);
          });
        },
        onEdgesChange: (changes) => {
          set((state) => {
            state.edges = applyEdgeChanges<WorkflowEdge>(changes, state.edges);
          });
        },
        onNodesChange: (changes) => {
          const selectedNodeId = get().selectedNodeId;
          const selectedNodeLostFocus = changes.some(
            (change) => change.type === "select" && change.id === selectedNodeId && !change.selected,
          );
          const measuredDimensionsByNodeId = new Map(
            changes.flatMap((change) =>
              change.type === "dimensions" && change.dimensions ? [[change.id, change.dimensions] as const] : [],
            ),
          );

          set((state) => {
            state.nodes = applyNodeChanges<WorkflowNode>(changes, state.nodes).map((node) => {
              const dimensions = measuredDimensionsByNodeId.get(node.id);
              const centerOriginNode = node as CenteringWorkflowNode;

              if (!dimensions || centerOriginNode.origin?.[0] !== 0.5 || centerOriginNode.origin[1] !== 0.5) {
                return node;
              }

              const { origin: _origin, ...workflowNode } = centerOriginNode;

              return {
                ...workflowNode,
                position: {
                  x: node.position.x - dimensions.width / 2,
                  y: node.position.y - dimensions.height / 2,
                },
              };
            });
            state.selectedNodeId = selectedNodeLostFocus ? null : selectedNodeId;
          });
        },
        selectNode: (nodeId) => {
          set((state) => {
            state.selectedNodeId = nodeId;
          });
        },
        setSaveState: (saveState) => {
          set((state) => {
            state.saveState = saveState;
          });
        },
        updateNodeData: (nodeId, data) => {
          set((state) => {
            const nodeIndex = state.nodes.findIndex((node) => node.id === nodeId);
            const node = state.nodes[nodeIndex];

            if (!node) {
              return;
            }

            node.data = data;
          });
        },
      })),
    ),
  );
}
