# Faceless Factory Runtime

This context defines the domain language for the node-based media runtime, including execution, review, replacement tasks, and dependency gating.

## Language

**Task**:
One concrete run to produce one branch result for one node run.
_Avoid_: Task, job, output job

**Task Input Materialization**:
The queue-time process that freezes a task's provider-ready input snapshot from the workflow blueprint, static upstream values, resolved parent tasks, provider settings, and idempotency key.
_Avoid_: Live rendering, worker graph resolution

**Node Run**:
A durable batch grouping of tasks for a single graph node.
_Avoid_: Node Run, header, node job

**Branch Index**:
The zero-based position of the parallel result flow a task attempts to produce within a node run.
_Avoid_: Branch Index, slot index

**Waiting Upstream**:
A task state where execution is parked until all parent tasks settle successfully.
_Avoid_: Waiting, blocked

**Active Task**:
A task in any non-terminal state.
_Avoid_: Queued task

**Latest Task**:
The most recently created task for one **Node Run** and **Branch Index**.
_Avoid_: Current attempt, selected version

**Wake-Up Call**:
The orchestration pattern where a settled parent task triggers readiness checks for its child tasks.
_Avoid_: Polling, dependency loop

**Upstream Failed**:
A terminal task state inherited from a failed parent task.
_Avoid_: Skipped, blocked failed

**Rejected**:
A terminal task state where a generated result was explicitly not accepted during review.
_Avoid_: Failed, errored

**Cancelled**:
A terminal task state where the user intentionally stopped work before approval.
_Avoid_: Failed, manual failure

**Run Node**:
A user command that asks the server to execute a graph node now. The server decides from persisted runtime state whether this creates the first **Node Run** or a new **Node Run**.
_Avoid_: Rerun node, run target node

**Run Task**:
A user command that creates the next **Task** for one **Branch Index** within an existing **Node Run**.
_Avoid_: Run Task, run branch, regenerate item, rerun item

**Branch**:
A parallel result flow within a node, identified by a **Branch Index**.
_Avoid_: Task, Node Slot, graph branch, output slot

**Task Status Event**:
A real-time notification that identifies one task, its new status, and optional renderable output payload.
_Avoid_: Dependency event, provenance event

**Post-Commit Work**:
Work derived from a committed runtime transaction that must happen after commit, such as publishing Task Status Events or enqueueing execution and Wake-Up Call jobs.
_Avoid_: Side effect, after-commit callback

**Workflow Event Stream**:
A tRPC subscription delivered over server-sent events for workflow task updates.
_Avoid_: WebSocket, socket event

**Task Dependency**:
A durable requirement from one child task to a parent node run branch, resolved to the exact parent latest task when the child is queued.
_Avoid_: Node dependency, latest dependency

**Task Debit**:
A debit charged for exactly one **Task** immediately before that **Task** moves to `QUEUED`; it is considered spent unless settlement creates a refund or cost reconciliation.
_Avoid_: Credit reservation, reserved credits, execution debit, output debit

**Task Cost Adjustment**:
An optional post-settlement debit for a **Task** when an LLM provider's actual cost exceeds the Task's credit cost.
_Avoid_: Final cost, final cost credits, reserved reconciliation

**Task Refund**:
A credit ledger refund for a **Task Debit** after queued cancellation or provider/infrastructure failure.
_Avoid_: Reservation release, cost reversal

**Pricing Catalog**:
The server-side source of truth for supported node/model credit costs used to assign a Task credit cost.
_Avoid_: Client-provided cost, saved graph cost

**Execution Cost Projection**:
A server-derived projection that assigns displayable own-node run costs from the Pricing Catalog to workflow nodes without persisting those costs in the workflow document.
_Avoid_: Client-computed cost, saved node cost

**Run Cost Preview**:
A pre-run summary of the Tasks that will be created or queued by a run command, including target and upstream branch costs.
_Avoid_: Node cost, aggregate node badge

## Relationships

- A **Node Run** has one or more **Tasks**.
- A **Task** belongs to exactly one **Node Run** and one **Branch Index**.
- User-facing output labels use **Branch** for parallel results; graph topology should use connection/path language instead of branch language.
- A **Task** is the durable source of truth for scheduling, retry, review, replacement, and dependency gating.
- **Task Input Materialization** is the only path that creates or refreshes a **Task** input snapshot before the task becomes `QUEUED`.
- **Task Input Materialization** freezes static upstream blueprint values and target node settings when a **Task** is created, including **Waiting Upstream** tasks.
- A **Wake-Up Call** for a **Waiting Upstream** **Task** binds only generated parent outputs from resolved parent **Tasks**; it does not re-read live list, prompt, asset, or target generator settings from the workflow document.
- Later non-semantic edits such as node position changes do not affect already-created **Tasks** because workers execute materialized input snapshots instead of live blueprint state.
- A **Node Run** is the durable batch record; there is no separate **Workflow Execution** concept in the domain model.
- A **Node Run** does not have an authoritative execution status; visible node state is derived from its latest **Tasks**.
- A node gets its first **Node Run** when it is first run manually or when downstream execution needs a batch for dependency linking.
- A node with an existing **Node Run** only gets a new **Node Run** when the user issues **Run Node** for that node.
- The UI shows the latest **Node Run** for each node by default.
- **Run Node** creates a new **Node Run** only for the selected node when that node already has execution history; existing downstream **Tasks** remain historical and frozen to their resolved dependencies.
- **Run Node** plans the full upstream closure needed by that node in one transaction when the node has no existing **Node Run**.
- Upstream closure planning creates missing **Node Runs**, **Tasks**, and **Task Dependencies**, queues satisfied **Tasks**, and parks unsatisfied **Tasks** as `WAITING_UPSTREAM`.
- Downstream planning reuses the latest existing upstream **Node Run** when one exists.
- Downstream planning creates an upstream **Node Run** only when the upstream node has none.
- When downstream planning finds a latest upstream **Task** in `FAILED`, `CANCELLED`, or `UPSTREAM_FAILED`, it creates a new upstream **Task** and parks the downstream **Task** on it.
- Downstream planning does not create duplicate upstream **Tasks** for branches already in `WAITING_UPSTREAM`, `QUEUED`, `RUNNING`, or `PENDING_REVIEW`.
- Running a downstream target may create downstream **Tasks** that wait on active upstream **Tasks**.
- `REJECTED` is not expected to remain the latest branch state because rejection immediately creates a newer **Task**.
- **Run Task** preserves the **Node Run** and creates a new **Task** only for the selected **Branch Index**.
- **Run Node** creates the first **Node Run** when none exists, or a new **Node Run** with fresh **Tasks** for all planned **Branch Indexes** when one already exists.
- **Run Node** is rejected when the node's latest **Node Run** has any **Active Tasks**.
- At most one **Active Task** may exist for a **Node Run** and **Branch Index**.
- **Latest Task** is determined by task creation time within the same **Node Run** and **Branch Index**.
- The server enforces the one-active-task invariant transactionally; frontend controls only prevent obvious duplicate user actions.
- The database enforces active-task uniqueness for each **Node Run** and **Branch Index** across `WAITING_UPSTREAM`, `QUEUED`, `RUNNING`, and `PENDING_REVIEW` tasks.
- A **Task** in **Waiting Upstream** consumes no worker resources; it is resumed only by a **Wake-Up Call** from a settled parent task.
- A **Task** moves through `WAITING_UPSTREAM`, `QUEUED`, `RUNNING`, `PENDING_REVIEW`, `APPROVED`, `REJECTED`, `CANCELLED`, `FAILED`, or `UPSTREAM_FAILED`.
- If an upstream **Task** fails, downstream **Tasks** that depend on it become **Upstream Failed** instead of remaining parked indefinitely.
- A directly **Failed** **Task** may be retried; an **Upstream Failed** **Task** requires running its failed upstream path first.
- A **Rejected** **Task** is not an execution failure; it is a reviewed item that was not accepted.
- Rejecting a **Task** is a server-side **Run Task** command: the rejected task becomes `REJECTED` and a newer **Task** is created immediately.
- A **Cancelled** **Task** propagates to waiting downstream **Tasks** as `UPSTREAM_FAILED`.
- If review is disabled for a generated output, successful generation transitions the **Task** directly to `APPROVED`.
- Downstream execution may consume only `APPROVED` parent **Tasks**; `PENDING_REVIEW` output is renderable but does not satisfy dependencies.
- A later upstream **Run Node** does not automatically resume a downstream **Task** already marked **Upstream Failed**.
- A **Task Dependency** stores a logical requirement address while the child **Task** is waiting: parent **Node Run** plus **Branch Index**.
- **Task Dependencies** represent generated parent **Task** requirements only; static upstream blueprint values are frozen in the **Task** input snapshot, not stored as **Task Dependencies**.
- A **Task Dependency** stores the resolved exact parent **Latest Task** before the child **Task** is queued or run.
- **Run Task** can satisfy unresolved **Task Dependencies** through the same parent **Node Run** and **Branch Index** without rewriting child dependencies.
- An unresolved **Task Dependency** is satisfied only when the **Latest Task** for the required **Node Run** and **Branch Index** is `APPROVED`.
- Once a child **Task** becomes `QUEUED`, its **Task Dependencies** are frozen to exact resolved parent **Tasks** and are not affected by later **Run Task**.
- An `APPROVED` **Task** remains approved forever; later **Run Task** creates a newer **Task** without mutating historical approval.
- When a newer **Task** is created for a required branch, unresolved downstream **Task Dependencies** wait for that newer **Task** even if an older **Task** is `APPROVED`.
- The gatekeeper transaction is the only path that moves a dependency-waiting child **Task** to `QUEUED`.
- The gatekeeper re-checks latest required tasks at commit time; creating newer upstream tasks does not require rewriting already waiting children.
- The gatekeeper resolves each satisfied **Task Dependency** to an exact parent **Task** and snapshots the child input payload before moving the child **Task** to `QUEUED`.
- A queued **Task** stores an immutable input snapshot; workers execute that snapshot instead of reading the live graph or latest dependencies.
- A **Task** input snapshot stores the minimal execution contract: task identity, target node configuration, resolved parent outputs, relevant document revision, provider settings, and idempotency key.
- A **Task** input snapshot includes fully rendered provider input plus structured provenance; workers do not perform graph or prompt resolution.
- A **Task** idempotency key is scoped to the concrete task, such as `task:{taskId}`.
- Credits are debited immediately before a **Task** moves to `QUEUED`, not when it is created as `WAITING_UPSTREAM`.
- A **Task Debit** is charged only after input materialization and other pre-provider checks succeed, to avoid unnecessary refunds.
- A **Task Debit** is per **Task** at the moment that task becomes `QUEUED`.
- A **Task Debit** belongs to exactly one **Task**.
- Execution-level credit language is obsolete; credit debits and refunds are modeled through **Tasks** and the credit ledger.
- Task credit accounting uses a debit/refund model in the credit ledger.
- A **Task** stores a single credit cost for its lifecycle.
- A **Task** credit cost is known and stored when the **Task** is created, including while it is `WAITING_UPSTREAM`.
- A **Task** credit cost is immutable after the **Task** is created; Pricing Catalog changes affect newly planned Tasks only.
- A **Task** credit cost comes from the server-side **Pricing Catalog**, not from client-supplied workflow document JSON.
- The UI may display **Pricing Catalog** costs, but saved workflow documents do not persist pricing as node configuration.
- The **Execution Cost Projection** feeds own-node run costs to the UI in one server-derived projection for all relevant generation nodes.
- Node UI displays only its own execution cost; it does not include upstream costs.
- Aggregate target-plus-upstream cost belongs to a **Run Cost Preview** shown before a run command that will create or queue upstream Tasks.
- A **Run Cost Preview** itemizes which node branches are expected to run and the credit cost for each branch.
- A **Run Cost Preview** is computed by the same planning Module that creates Tasks, using a read-only preview mode.
- A **Run Cost Preview** includes Tasks the command will create, grouped by whether they are expected to debit immediately or wait upstream for a future debit.
- A run command requires current balance only for Tasks moving to `QUEUED` immediately; waiting upstream cost is disclosed but not reserved.
- A **Run Cost Preview** excludes already active or approved upstream Tasks from the new-cost total.
- The **Task Debit** amount comes from the Task's stored credit cost and is charged only when the Task is ready to move to `QUEUED`.
- LLM provider cost overage after settlement is recorded as a **Task Cost Adjustment** in the credit ledger, not as a second Task cost field.
- **Task Cost Adjustments** are only additional debits when actual LLM cost exceeds the Task's credit cost; lower actual cost does not create a refund.
- Credit ledger amounts are whole credits for this MVP; fractional **Task Cost Adjustments** round up to the nearest whole credit.
- Planning can create **Tasks** regardless of current credit balance; insufficient credits fail only when a task attempts to become `QUEUED`.
- If a **Task Debit** cannot be charged, the **Task** becomes `FAILED` and waiting downstream **Tasks** cascade to `UPSTREAM_FAILED`.
- Direct task failures use `FAILED` with a structured failure reason such as `INSUFFICIENT_CREDITS`.
- Failed **Tasks** do not auto-resume after external conditions change; retry requires explicit user action.
- A **Task** may be cancelled without credit impact while it is `WAITING_UPSTREAM` because no **Task Debit** has been charged yet.
- Cancelling a `QUEUED` **Task** refunds its **Task Debit** because provider work has not started.
- Cancelling a `RUNNING` **Task** is blocked for this MVP; if cancellation is later allowed after provider work starts, the **Task Debit** is still considered spent unless an adapter proves no external cost occurred.
- Cancelling a post-provider **Task** does not refund its **Task Debit**.
- A failed `RUNNING` **Task** receives a **Task Refund** only when the failure source explicitly marks it refundable.
- Failed provider work is treated as billable by default after a **Task** reaches `RUNNING`; a provider adapter must explicitly mark the failure as refundable for a **Task Refund** to be created.
- Post-provider infrastructure failure is not automatically refundable because recovery may still surface the generated result; the failure source must explicitly mark the Task refundable.
- `PENDING_REVIEW` **Tasks** are not cancellable; review uses **Rejected** or approval, and replacement uses **Run Task**.
- Input-hash-based output reuse is not part of the domain; **Run Node** and **Run Task** always create new generation tasks for their selected runtime addresses.
- Input hashes are not stored in the runtime schema.
- Existing execution/runtime data is disposable during the overhaul; backward compatibility with old tasks, node runs, and legacy execution artifact records is not required.
- A saved workflow document is a blueprint: it stores creative configuration and graph structure, not execution history, review state, or generated output attempts.
- Review state lives in the **Task** status machine; no separate review metadata is required.
- Generated outputs are stored as **Assets**, including generated text.
- **Assets** are the durable catalog for uploaded inputs and generated outputs.
- **Assets** are workflow-local and belong to the workflow owner.
- Generated **Assets** point directly to their producing **Task**; output ordering within a task is not part of this overhaul.
- This overhaul treats each completed **Task** as producing exactly one primary generated **Asset**.
- Generated text **Assets** store their text inline in the asset record for this overhaul.
- A **Task Status Event** includes `taskId`, `nodeRunId`, `branchIndex`, `status`, and an optional renderable output payload.
- Renderable asset payloads use CDN URLs for immediate display and keep asset ids as stable identities.
- Renderable text payloads include the full generated text; LLM node output limits constrain event size.
- The **Workflow Event Stream** uses SSE through a tRPC subscription; user commands remain HTTP/tRPC mutations.
- The **Workflow Event Stream** is backed by Redis Pub/Sub so worker processes can publish events consumed by web server subscriptions.
- **Task Status Events** are published only after the database transaction that produced them commits.
- Execution jobs are enqueued only after the database transaction that marks tasks `QUEUED` commits.
- **Post-Commit Work** is delivered after commit on a best-effort basis during the MVP.
- User commands remain successful once the runtime transaction commits, even if **Post-Commit Work** delivery fails.
- If best-effort **Post-Commit Work** delivery is missed, the user can cancel affected active tasks and run the leaf node again to re-plan the upstream cascade from durable state.
- **Post-Commit Work** enqueues Wake-Up Call jobs; it does not process Wake-Up Call domain logic inline.
- Wake-Up Call workers run the gatekeeper transaction and may produce their own **Post-Commit Work**.
- Orchestrator queue events use deterministic job ids and idempotent handlers; queue deduplication is a safety net, not the source of truth.
- BullMQ custom `jobId` values must not contain `:` because BullMQ reserves colon-delimited ids for repeatable-job internals. Workflow runtime queue job ids use `~` as the structural delimiter.
- The orchestrator owns durable task state transitions and downstream wake-up decisions.
- BullMQ queue events are operational signals for observability and reconciliation, not the domain orchestration path.
- Execution workers may directly claim `QUEUED` tasks as `RUNNING` through a narrow atomic claim function before spending resources.
- The atomic worker claim function publishes the `RUNNING` **Task Status Event** only after its database update commits.
- A **Wake-Up Call** only checks already-created child **Tasks**; approving one node does not automatically start every downstream node unless those downstream **Tasks** were created by the original run request.

## Example Dialogue

> **Dev:** "If an image node generates four images, do we schedule one job or four?"
> **Domain expert:** "Four **Tasks**. Each **Task** produces one branch result and can be reviewed or replaced independently by running that task again."

## Flagged Ambiguities

- "task" was used broadly; resolved: **Task** is the canonical item-level run, while queue jobs are infrastructure concerns.
- "workflow execution" was considered as a parent run record; resolved: **Node Run** carries the durable batch grouping needed by **Tasks**.
- "header" was used for the visible batch grouping; resolved: the canonical term is **Node Run**.
- "waiting" was used broadly; resolved: the canonical parked dependency state is **Waiting Upstream**.
