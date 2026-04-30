# Faceless Factory Workflow Runtime

This context defines the domain language for the node-based media workflow runtime, including execution, review, regeneration, and dependency gating.

## Language

**Task Run**:
One attempt to produce one item for one node execution.
_Avoid_: Task, job, output job

**Node Execution**:
A durable batch grouping of task runs for a single graph node.
_Avoid_: Header, node run, node job

**Item Index**:
The zero-based position of the item a task run attempts to produce within a node execution.
_Avoid_: Slot index

**Attempt**:
The version number of a task run for a specific item index within a node execution.
_Avoid_: Try, regeneration number

**Waiting Upstream**:
A task run state where execution is parked until all parent task runs settle successfully.
_Avoid_: Waiting, blocked

**Active Task Run**:
A task run in any non-terminal state.
_Avoid_: Queued task

**Wake-Up Call**:
The orchestration pattern where a settled parent task run triggers readiness checks for its child task runs.
_Avoid_: Polling, dependency loop

**Upstream Failed**:
A terminal task run state inherited from a failed parent task run.
_Avoid_: Skipped, blocked failed

**Rejected**:
A terminal task run state where a generated item was explicitly not accepted during review.
_Avoid_: Failed, errored

**Cancelled**:
A terminal task run state where the user intentionally stopped an attempt before approval.
_Avoid_: Failed, manual failure

**Regenerate Item**:
A command that creates the next attempt for selected item indexes within the same node execution.
_Avoid_: Rerun node

**Rerun Node**:
A command that creates a new node execution and fresh attempts for all planned item indexes of that node.
_Avoid_: Regenerate item

**Task Status Event**:
A real-time notification that identifies one task run attempt, its new status, and optional renderable output payload.
_Avoid_: Dependency event, provenance event

**Workflow Event Stream**:
A tRPC subscription delivered over server-sent events for workflow task updates.
_Avoid_: WebSocket, socket event

**Task Dependency**:
A durable requirement from one child task run to a parent node execution item, resolved to an exact parent task run when the child is queued.
_Avoid_: Node dependency, latest dependency

## Relationships

- A **Node Execution** has one or more **Task Runs**.
- A **Task Run** belongs to exactly one **Node Execution**, one **Item Index**, and one **Attempt**.
- A **Task Run** is the durable source of truth for scheduling, retry, review, regeneration, and dependency gating.
- A **Node Execution** is the durable batch record; there is no separate **Workflow Execution** concept in the domain model.
- A **Node Execution** does not have an authoritative execution status; visible node state is derived from its latest **Task Runs**.
- A node gets its first **Node Execution** when it is first run manually or when downstream execution needs a batch for dependency linking.
- A node with an existing **Node Execution** only gets a new **Node Execution** when the user manually reruns that node.
- The UI shows the latest **Node Execution** for each node by default.
- A manual rerun creates a new **Node Execution** only for the rerun node; existing downstream **Task Runs** remain historical and frozen to their resolved dependencies.
- Running a target node plans the full upstream closure needed by that target in one transaction.
- Upstream closure planning creates missing **Node Executions**, **Task Runs**, and **Task Dependencies**, queues satisfied **Task Runs**, and parks unsatisfied **Task Runs** as `WAITING_UPSTREAM`.
- Downstream planning reuses the latest existing upstream **Node Execution** when one exists.
- Downstream planning creates an upstream **Node Execution** only when the upstream node has none.
- When downstream planning finds a latest upstream slot attempt in `FAILED`, `CANCELLED`, or `UPSTREAM_FAILED`, it creates a new upstream **Attempt** and parks the downstream **Task Run** on it.
- Downstream planning does not create duplicate upstream attempts for slots already in `WAITING_UPSTREAM`, `QUEUED`, `RUNNING`, or `PENDING_REVIEW`.
- Running a downstream target may create downstream **Task Runs** that wait on active upstream **Task Runs**.
- `REJECTED` is not expected to remain the latest slot state because rejection immediately creates a newer **Attempt**.
- **Regenerate Item** preserves the **Node Execution** and creates a new **Attempt** only for selected **Item Indexes**.
- **Rerun Node** creates a new **Node Execution** and fresh **Task Runs** for all planned **Item Indexes**.
- **Rerun Node** is rejected when the node's latest **Node Execution** has any **Active Task Runs**.
- Running a target node is rejected when that target node's latest **Node Execution** has any **Active Task Runs**.
- At most one active non-terminal **Attempt** may exist for a **Node Execution** and **Item Index**.
- The server enforces the one-active-attempt invariant transactionally; frontend controls only prevent obvious duplicate user actions.
- The database enforces active-slot uniqueness for each **Node Execution** and **Item Index** across `WAITING_UPSTREAM`, `QUEUED`, `RUNNING`, and `PENDING_REVIEW` attempts.
- A **Task Run** in **Waiting Upstream** consumes no worker resources; it is resumed only by a **Wake-Up Call** from a settled parent task run.
- A **Task Run** moves through `WAITING_UPSTREAM`, `QUEUED`, `RUNNING`, `PENDING_REVIEW`, `APPROVED`, `REJECTED`, `CANCELLED`, `FAILED`, or `UPSTREAM_FAILED`.
- If an upstream **Task Run** fails, downstream **Task Runs** that depend on it become **Upstream Failed** instead of remaining parked indefinitely.
- A directly **Failed** **Task Run** may be retried; an **Upstream Failed** **Task Run** requires rerunning or regenerating its failed upstream path first.
- A **Rejected** **Task Run** is not an execution failure; it is a reviewed item that was not accepted.
- Rejecting a **Task Run** is a server-side regeneration command: the rejected attempt becomes `REJECTED` and a newer **Attempt** is created immediately.
- A **Cancelled** **Task Run** propagates to waiting downstream **Task Runs** as `UPSTREAM_FAILED`.
- If review is disabled for a generated output, successful generation transitions the **Task Run** directly to `APPROVED`.
- Downstream execution may consume only `APPROVED` parent **Task Runs**; `PENDING_REVIEW` output is renderable but does not satisfy dependencies.
- A later upstream rerun does not automatically resume a downstream **Task Run** already marked **Upstream Failed**.
- A **Task Dependency** stores a logical requirement address while the child **Task Run** is waiting: parent **Node Execution** plus **Item Index**.
- A **Task Dependency** stores the resolved exact parent **Task Run** before the child **Task Run** is queued or run.
- Regeneration can satisfy unresolved **Task Dependencies** through the same parent **Node Execution** and **Item Index** without rewriting child dependencies.
- An unresolved **Task Dependency** is satisfied only when the latest **Attempt** for the required **Node Execution** and **Item Index** is `APPROVED`.
- Once a child **Task Run** becomes `QUEUED`, its **Task Dependencies** are frozen to exact resolved parent **Task Runs** and are not affected by later regeneration.
- An `APPROVED` **Attempt** remains approved forever; later regeneration creates a newer **Attempt** without mutating historical approval.
- When a newer **Attempt** is created for a required slot, unresolved downstream **Task Dependencies** wait for that newer **Attempt** even if an older **Attempt** is `APPROVED`.
- The gatekeeper transaction is the only path that moves a dependency-waiting child **Task Run** to `QUEUED`.
- The gatekeeper re-checks latest required attempts at commit time; creating newer upstream attempts does not require rewriting already waiting children.
- The gatekeeper resolves each satisfied **Task Dependency** to an exact parent **Task Run** and snapshots the child input payload before moving the child **Task Run** to `QUEUED`.
- A queued **Task Run** stores an immutable input snapshot; workers execute that snapshot instead of reading the live graph or latest dependencies.
- A **Task Run** input snapshot stores the minimal execution contract: task identity, target node configuration, resolved parent outputs, relevant document revision, provider settings, and idempotency key.
- A **Task Run** input snapshot includes fully rendered provider input plus structured provenance; workers do not perform graph or prompt resolution.
- A **Task Run** idempotency key is scoped to the concrete attempt, such as `task_run:{taskRunId}:attempt:{attempt}`.
- A **Task Run** stores final cost attribution for its attempt; the credit ledger remains the financial audit trail.
- Credits are reserved immediately before a **Task Run** moves to `QUEUED`, not when it is created as `WAITING_UPSTREAM`.
- Credit reservation is per **Task Run** at the moment that task run becomes `QUEUED`.
- Credit reservation uses a debit/refund model in the credit ledger.
- A **Task Run** stores both reserved credits and final cost credits.
- Planning can create **Task Runs** regardless of current credit balance; insufficient credits fail only when a task run attempts to become `QUEUED`.
- If credit reservation fails, the **Task Run** becomes `FAILED` and waiting downstream **Task Runs** cascade to `UPSTREAM_FAILED`.
- Direct task failures use `FAILED` with a structured failure reason such as `INSUFFICIENT_CREDITS`.
- Failed **Task Runs** do not auto-resume after external conditions change; retry requires explicit user action.
- Input-hash-based output reuse is not part of the domain; rerunning or regenerating always creates a new generation attempt.
- Input hashes are not stored in the workflow runtime schema.
- Existing execution/runtime data is disposable during the overhaul; backward compatibility with old task runs, node executions, and execution artifacts is not required.
- A saved workflow document is a blueprint: it stores creative configuration and graph structure, not execution history, review state, or generated output attempts.
- Review state lives in the **Task Run** status machine; no separate review metadata is required.
- Generated outputs are stored as **Assets**, including generated text.
- **Assets** are the durable catalog for uploaded inputs and generated outputs.
- **Assets** are workflow-local and belong to the workflow owner.
- Generated **Assets** point directly to their producing **Task Run**; output ordering within a task run is not part of this overhaul.
- This overhaul treats each completed **Task Run** as producing exactly one primary generated **Asset**.
- Generated text **Assets** store their text inline in the asset record for this overhaul.
- A **Task Status Event** includes `taskRunId`, `nodeExecutionId`, `itemIndex`, `attempt`, `status`, and an optional renderable output payload.
- Renderable asset payloads use CDN URLs for immediate display and keep asset ids as stable identities.
- Renderable text payloads include the full generated text; LLM node output limits constrain event size.
- The **Workflow Event Stream** uses SSE through a tRPC subscription; user commands remain HTTP/tRPC mutations.
- The **Workflow Event Stream** is backed by Redis Pub/Sub so worker processes can publish events consumed by web server subscriptions.
- **Task Status Events** are published only after the database transaction that produced them commits.
- Execution jobs are enqueued only after the database transaction that marks task runs `QUEUED` commits.
- A queued-task sweeper idempotently re-enqueues durable `QUEUED` task runs that missed BullMQ enqueueing.
- Orchestrator queue events use deterministic job ids and idempotent handlers; queue deduplication is a safety net, not the source of truth.
- The orchestrator owns durable task-run state transitions and downstream wake-up decisions.
- BullMQ queue events are operational signals for observability and reconciliation, not the domain orchestration path.
- Execution workers may directly claim `QUEUED` task runs as `RUNNING` through a narrow atomic claim function before spending resources.
- The atomic worker claim function publishes the `RUNNING` **Task Status Event** only after its database update commits.
- A **Wake-Up Call** only checks already-created child **Task Runs**; approving one node does not automatically start every downstream node unless those downstream **Task Runs** were created by the original run request.

## Example Dialogue

> **Dev:** "If an image node generates four images, do we schedule one job or four?"
> **Domain expert:** "Four **Task Runs**. Each **Task Run** produces one item and can be reviewed or regenerated independently."

## Flagged Ambiguities

- "task" was used broadly; resolved: **Task Run** is the canonical item-level attempt, while queue jobs are infrastructure concerns.
- "workflow execution" was considered as a parent run record; resolved: **Node Execution** carries the durable batch grouping needed by **Task Runs**.
- "header" was used for the visible batch grouping; resolved: the canonical term is **Node Execution**.
- "waiting" was used broadly; resolved: the canonical parked dependency state is **Waiting Upstream**.
