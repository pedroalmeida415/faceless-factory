# Faceless Factory

Faceless Factory is a generative media workflow system for composing image and video pipelines. This context captures the domain language used by product, design, tests, and implementation.

## Language

**Branch**:
One parallel execution lane produced by zipping or broadcasting a node's array-shaped inputs.
_Avoid_: Iteration, item, lane, index, batch item
_User-facing_: Use in workflow UI copy.

**Branch Count**:
The number of parallel **Branches** a node will execute after applying zip and broadcast rules to its inputs.
_Avoid_: Parallelism, array length, iterations

**Branch Batch Size**:
The requested number of output alternatives generated for each **Branch**.
_Avoid_: Batch size, output count, samples, variants
_User-facing_: Label as "Batch size" with helper text that it applies per **Branch**.

**Batch Item**:
One generated output slot within a **Branch**.
_Avoid_: Branch, variant
_Internal_: Use media-specific labels such as image or video in user-facing UI copy.

**Asset Order**:
The user-controlled order of assets in an **Asset** input node.
_Avoid_: Upload order when reordered, unordered assets

**Cardinality**:
Whether a node value is a single value or an array-shaped value.
_Avoid_: Array type, multiplicity

**Data Type**:
The kind of media or value a node connector accepts or produces.
_Avoid_: Cardinality, array type

**Edge**:
A direct connection between two node **Sockets** in the workflow graph.
_Avoid_: Path, connection

**Generation Node**:
An executable node that creates generated media from its configured inputs.
_Avoid_: Executable node, model node, provider node

**Generated Asset**:
A persisted media asset produced by a **Generation Node**.
_Avoid_: Run history item, temporary output

**Generated Output**:
The current output value exposed by a **Generation Node** to downstream nodes.
_Avoid_: Run history, provider response

**Branch Readiness**:
Whether a specific **Branch** has all required upstream values needed to run downstream work.
_Avoid_: Node readiness, workflow readiness

**AI Generation Operation**:
The rate-limited runtime operation that produces one **Batch Item**.
_Avoid_: Task, branch
_Internal_: Runtime term; do not use in user-facing workflow UI copy.

**Selected Batch Item**:
The single **Batch Item** chosen for a **Branch** of a **Generation Node** result to move forward through downstream **Edges**.
_Avoid_: Auto-selected output, generated output array

**Generation Cost**:
The deterministic upfront credit cost for a **Generation Node** run.
_Avoid_: Estimated cost, actual cost after execution

**Workflow Graph**:
The persisted workflow definition containing nodes, edges, node positions, input values, and node config.
_Avoid_: Execution state, runtime state

**Input Node**:
A static node that provides user-authored values to other nodes without running generation.
_Avoid_: Executable input, static executable

**List Item**:
One ordered text value in a **List** input node.
_Avoid_: Text line, prompt branch

**Blank List Item**:
An empty **List Item** that is editable but does not participate in **Input Alignment**.
_Avoid_: Empty branch, empty prompt

**Input Capacity**:
The maximum number of connections allowed for a repeatable **Node Input** on a selected model.
_Avoid_: Unlimited inputs, connection limit

**Input Alignment**:
The rule that derives **Branch Count** by zipping equal-length arrays, broadcasting single values, and blocking mismatched non-single arrays.
_Avoid_: Parallelism logic, zip logic

**Material Graph Change**:
A change to authored workflow definition that should save the workflow's current **Workflow Graph**.
_Avoid_: View state change, runtime update

**Model**:
The user-visible generation capability selected on a **Generation Node**.
_Avoid_: Provider, backend provider

**Model ID**:
The stable persisted identifier for a **Model** in the **Workflow Graph**.
_Avoid_: Display name, provider name

**Model Catalog**:
The schema describing available **Models**, their sockets, config defaults, capacities, and display metadata.
_Avoid_: Provider registry, hard-coded drawer

**Text Draft**:
An uncommitted text edit shown only inside the focused text input until blur.
_Avoid_: Graph value, committed value

**Node Input**:
A graph-connected value accepted by a node through a **Socket**.
_Avoid_: Config field, setting

**No Value**:
The absence of a usable value from an input node or socket.
_Avoid_: Empty array, empty string

**Optional Node Input**:
A **Node Input** that can receive **No Value** without blocking generation.
_Avoid_: Ignored required input

**Required Node Input**:
A **Node Input** that must receive a usable value before generation can run.
_Avoid_: Optional input

**Node Config**:
A node setting edited outside graph connectors that applies to every **Branch** of that node.
_Avoid_: Node input, connector value

**Output Display Mode**:
The way a **Generation Node** presents its generated outputs inside the node.
_Avoid_: Drawer results view

**Path**:
An execution route that forms through one or more **Edges** when workflow outputs diverge through the graph.
_Avoid_: Edge, branch

**Socket**:
The visible connection point on a node where an **Edge** can start or end.
_Avoid_: Handle, connector, port

**Repeatable Socket**:
A **Socket** group that can accept multiple **Edges** up to its **Input Capacity**.
_Avoid_: Multi-input handle, socket list

**Run Snapshot**:
The frozen input and config values used to create a node run.
_Avoid_: Current graph state, live inputs

**Result Set**:
The current generated outputs attached to a **Generation Node** for its latest **Run Snapshot**.
_Avoid_: Run history

**Stale Result**:
A generated result whose upstream inputs or node config have changed since its **Run Snapshot** was created.
_Avoid_: Outdated output, dirty result

**Task**:
The branch-level runtime unit that owns dependency state and one or more **AI Generation Operations**.
_Avoid_: Batch item, AI generation operation
_Internal_: Runtime term; do not use in user-facing workflow UI copy.

**Workflow Execution Projection**:
The frontend-readable execution state hydrated for a workflow graph, including result sets, branch states, batch item states, stale flags, costs, and run status.
_Avoid_: Graph blueprint, local runtime

**Workflow Graph Projection**:
The frontend-readable graph definition hydrated from a workflow's **Workflow Graph**.
_Avoid_: Execution projection, runtime state

## Relationships

- An **Edge** directly connects two **Sockets**; a **Path** describes a broader execution route through one or more **Edges**.
- A **Path** describes graph execution topology; a **Branch** describes parallel execution data within a node.
- A node's **Branch Count** is derived from its input values through **Input Alignment**, not from worker concurrency or batch size.
- MVP workflows support a **Branch Count** of at most 50 for any node.
- Total generated outputs for a node equal **Branch Count** multiplied by **Branch Batch Size**.
- A **Branch** groups **Batch Items**, and each **Batch Item** has independent loading, error, success, and retry state.
- At runtime, each **Branch** executes as exactly one **Task**.
- Each **Batch Item** corresponds to one **AI Generation Operation** owned by the Branch's **Task**.
- Retrying a failed **Batch Item** uses the original **Run Snapshot**, not the current graph state.
- **Data Type** and **Cardinality** are separate: a **Socket** can accept text while the connected value may be single text or an array of text.
- Every **Generation Node** exposes **Branch Batch Size** as a user-facing config, even when a provider must emulate it internally.
- MVP execution is initiated independently per **Generation Node**, not through a global workflow run.
- The Run action for a **Generation Node** lives on the node itself, not in the config drawer.
- A **Generation Node** always shows generated outputs inside the node, not in the config drawer.
- A **Generation Node** can expose **Generated Outputs** to downstream **Generation Nodes** through **Edges**.
- A downstream **Edge** from a **Generation Node** requires one **Selected Batch Item** per upstream **Branch**; generated batch arrays are not forwarded automatically.
- **Selected Batch Item** is chosen inside the upstream **Generation Node** output display.
- Changing **Selected Batch Item** is a **Material Graph Change** because it changes downstream graph values.
- A **Generated Output** preserves upstream **Branch** order and behaves like an ordered asset array after **Selected Batch Items** are chosen.
- A **Workflow** belongs to exactly one user through `userId`.
- A **Workflow** stores one current **Workflow Graph** as `graph`; persisted workflow history is intentionally not modeled.
- Undo and redo history for graph editing is client-local and ephemeral unless persistent history becomes a product feature.
- **Branch Readiness** flows independently through the workflow: when an upstream **Branch** receives a **Selected Batch Item**, matching downstream **Branches** can become ready without waiting for other upstream **Branches**.
- The config drawer behaves as a **Generation Node** inspector and switches content when another **Generation Node** is focused.
- A **Generation Node** marks results as **Stale Results** when upstream inputs, incoming **Edges**, or **Node Config** change after the **Run Snapshot**.
- **Stale Results** are detected by comparing the current material inputs and **Node Config** against the previous **Run Snapshot**, not by exhaustively tracking UI events.
- A **Generation Node** with **Stale Results** shows a stale badge and labels its Run action as `Run again`.
- Canvas layout, drawer visibility, and **Output Display Mode** changes do not create **Stale Results**.
- A **Generation Node** keeps one current **Result Set**; rerunning replaces the existing **Result Set** with outputs for a new **Run Snapshot**.
- **Generated Assets** can be reused in new workflow entry points through **Asset** input nodes instead of through run history.
- Graph and config edits are allowed while a **Generation Node** is running, queued, or waiting upstream; committed edits affect future runs and can make existing results stale.
- A node with running, queued, or waiting-upstream execution state cannot be deleted until execution finishes or is canceled.
- The **Workflow Graph Projection** loads before the **Workflow Execution Projection** so execution state can be hydrated for the known graph nodes.
- The graph view combines the **Workflow Graph Projection** and **Workflow Execution Projection** so users can see both workflow definition and execution state.
- **Material Graph Changes** are debounced into workflow saves and include changes to any node, edge, node position, input value, or node config, whether or not the node is connected.
- Text input edits become **Material Graph Changes** only on blur, not on every keystroke.
- Downstream graph state uses the last committed graph value while a **Text Draft** is being edited.
- Discrete **Node Config** controls such as selects and segmented controls commit immediately and trigger autosave debounce.
- Changing a **Generation Node** model resets that model's config to its defaults.
- **Model** is user-facing; provider identity is internal wiring and is not shown in workflow UI.
- The **Workflow Graph** stores **Model ID** values, while the UI renders **Model** display names.
- The MVP uses a schema-driven in-memory **Model Catalog** fixture to render **Generation Node** sockets and config.
- **Generation Cost** is known before execution from **Branch Count**, **Branch Batch Size**, and **Model** pricing, and is presented as a deterministic cost.
- Failed **Batch Items** refund their debited **Generation Cost**; retrying follows the normal debit flow for a new generation attempt.
- The MVP workflow builder shows **Generation Cost** only and does not show credit balance or insufficient-funds checks in the graph UI.
- **Generation Nodes** show **Branch Count**, user-facing batch size, total output count, and **Generation Cost**.
- If a model change lowers **Input Capacity**, excess **Edges** on affected **Repeatable Sockets** are disconnected automatically without a warning.
- Ephemeral view changes such as focus, hover, drawer visibility, carousel page, fullscreen output view, and **Output Display Mode** do not save the **Workflow Graph**.
- **Output Display Mode** can be Single, where carousel pages step through **Branches** and show each Branch's batch, or All, showing every output in one masonry grid.
- **Output Display Mode** is ephemeral client state and is not part of the **Workflow Graph**.
- A **Generation Node** output view can expand to a full-screen dialog for detailed viewing.
- An **Input Node** can affect **Branch Count** by providing single or array-shaped values, but it does not run, spend credits, or produce generated media.
- **Input Nodes** are edited inline on the canvas and do not open the config drawer.
- Focusing an **Input Node** closes the config drawer if it is open.
- An empty **Prompt** input node produces **No Value**.
- An **Asset** input node with zero assets produces **No Value**.
- A **List** input node uses a structured editor of ordered **List Items**, not a multiline text area.
- **List Item** text edits commit on blur like other text inputs.
- **Blank List Items** are invalid for generation and do not count toward **Branch Count**.
- A **List** input node with only **Blank List Items** produces **No Value**.
- A **Required Node Input** receiving **No Value** blocks generation as a missing input.
- An **Optional Node Input** receiving **No Value** is ignored for generation and **Input Alignment**.
- An **Optional Node Input** with a usable value participates in **Input Alignment** like any other input.
- Adding a **List Item** focuses the first existing **Blank List Item** before creating a new row.
- Image **Generation Nodes** can accept image **Node Inputs** as references when the selected model supports them.
- **Input Capacity** is defined by the selected model and counts connected **Edges**, not resolved array values.
- A single **Edge** from an array-shaped value to a repeatable **Node Input** consumes one **Input Capacity** slot and can still produce multiple **Branches**.
- An **Edge** that resolves to **No Value** still consumes **Input Capacity** until disconnected.
- A **Repeatable Socket** shows connected **Sockets** plus exactly one empty next **Socket** until **Input Capacity** is reached.
- **Input Capacity** text on a **Repeatable Socket** appears only on hover or focus and uses socket index, such as `Image #2 (2/3)`.
- Connected count for a **Repeatable Socket** is shown separately from the socket label when needed.
- Only **Node Inputs** participate in **Branch Count** derivation; **Node Config** applies to every **Branch** without changing the **Branch Count**.
- All connected **Node Inputs**, including repeatable **Sockets**, use **Input Alignment** to derive **Branch Count**.
- **Input Alignment** zips array-shaped values by position, so **Asset Order** is meaningful and predictable.
- MVP **Asset Order** preserves insertion order; explicit asset reordering is out of scope for the first frontend slice.
- Failed **Input Alignment** blocks generation, marks the **Generation Node**, and identifies the mismatched non-single **Sockets** while leaving the graph editable.

## Example dialogue

> **Dev:** "If a List has three prompts and an Asset has one image, how many branches does the Image Generation node run?"
> **Domain expert:** "Three branches: the List defines the branch count, and the single Asset is broadcast to each Branch."

## Flagged ambiguities

- "branch" can mean graph topology in other node editors; resolved: use **Path** for graph execution topology and **Branch** for parallel execution lanes.
