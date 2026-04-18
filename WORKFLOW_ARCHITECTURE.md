# Workflow Architecture

This document explains how the workflow/editor code is structured, what each layer owns, and where future changes should go.

## Mental Model

Treat the workflow system as four layers:

1. Domain types
2. Persisted document
3. Graph rules and domain services
4. UI and store adapters

The shortest useful rule is:

- `document` is truth
- `editor` and `runtime` are overlays
- `engine` changes graph state
- `services` handle business mutations and side effects
- `UI` renders and dispatches

If a change feels awkward, it is usually being added at the wrong layer.

## Ownership Map

### Domain vocabulary

File: `src/lib/workflow/types.ts`

Owns:

- workflow node kinds
- asset shape
- generator settings
- runtime-facing node data unions

Use this file when you are adding a new domain concept or a new field that has business meaning.

### Persisted workflow document

File: `src/lib/workflow/document.ts`

Owns:

- the versioned workflow schema
- persisted node and edge shape
- default graph creation
- document normalization
- reset-on-incompatible-version behavior

Important rule:

- if it must survive refresh, export, import, or future migrations, it belongs in the document

Examples of document state:

- node positions
- prompt text
- uploaded asset references
- generator settings
- latest generator outputs and response text

Examples of things that do not belong in the document:

- selection state
- node measured width and height
- transient running status
- transient error banner text

### Handle and graph semantics

Files:

- `src/lib/workflow/node-definitions.ts`
- `src/lib/workflow/graph.ts`

These files define what the graph means.

`node-definitions.ts` owns:

- handle ids
- handle value types
- node output type mapping
- generator image handle conventions

`graph.ts` owns:

- adjacency helpers
- image-handle normalization
- connection compatibility
- cycle checks for proposed connections
- iterator batching rules
- iteration previews used by UI and validation

Use these files when the question is:

- Is this connection allowed?
- What type flows through this handle?
- How should iterator inputs batch?

### Validation

File: `src/lib/workflow/workflow-graph-validator.ts`

Owns:

- document integrity checks
- duplicate connection checks
- missing node checks
- cycle detection
- execution preconditions

Validation happens before execution. This keeps failures predictable and moves errors closer to the actual cause.

### Pure graph mutation engine

File: `src/lib/workflow/workflow-engine.ts`

Owns:

- graph mutation rules
- connect/delete/reset/add-node behavior
- normalization after mutations
- selection cleanup
- React Flow change application
- syncing document, editor, and runtime state into a coherent snapshot

Important rule:

- if a change modifies graph structure or editor graph behavior, it should probably go through the engine

This file should stay mostly pure. It should not know about uploads, TRPC, or model execution.

### Domain services

File: `src/lib/workflow/services/node-services.ts`

Owns:

- focused node-level business mutations

Examples:

- set prompt text
- update generator settings
- apply generator execution results
- clear or apply uploaded assets

The purpose of this layer is to keep business mutation rules out of components.

### Side-effect services

Files:

- `src/lib/workflow/services/workflow-client.ts`
- `src/lib/workflow/services/workflow-asset-service.ts`
- `src/lib/workflow/services/workflow-execution-service.ts`
- `src/lib/workflow/services/workflow-persistence-service.ts`
- `src/lib/workflow/services/workflow-studio-store-service.ts`

These files own effectful work.

`workflow-client.ts` wraps outbound requests.

`workflow-asset-service.ts` owns uploads and their status/activity flow.

`workflow-execution-service.ts` owns the full workflow run pipeline:

- build snapshot
- resolve targets
- validate graph
- resolve inputs
- execute upstream dependencies
- call model services
- persist latest generator results
- update runtime status and activity

`workflow-persistence-service.ts` owns localStorage load, save, reset, and reset-on-incompatible-version behavior.

`workflow-studio-store-service.ts` is the bridge that lets effect services interact with the Zustand store without importing component code everywhere.

### Store and UI adapters

Files:

- `src/components/workflow/studio/store.ts`
- `src/components/workflow/studio/useWorkflowStudioController.ts`
- `src/components/workflow/studio/context.ts`
- `src/components/workflow/studio/nodes.tsx`
- `src/components/workflow/WorkflowStudio.tsx`

These files should stay thin.

The store owns current client state and delegates behavior downward.

The controller translates UI interactions into store calls and effect runs.

The React components render and dispatch. They should not invent business rules.

## State Model

File: `src/lib/workflow/studio-state.ts`

The state is intentionally split into three categories.

### Document state

Persistent, versioned, durable.

Examples:

- nodes
- edges
- prompt text
- assets
- generator outputs

### Editor state

UI-only, not persisted.

Examples:

- selected node ids
- selected edge ids
- measured node dimensions

Important note:

- React Flow keeps controlled nodes hidden until it knows their measured width and height
- those measurements must stay in editor state
- they should never be persisted into the document

### Runtime state

Transient execution-only state.

Examples:

- node status
- node error
- current activity message
- generator outputs and response text

## Data Flow

The common state flow is:

1. Persisted `WorkflowDocument`
2. Combined with `editor` and `runtime` into a `WorkflowStudioSnapshot`
3. Converted into controlled React Flow `nodes` and `edges`
4. UI emits changes back into the store
5. The store routes those changes through the engine or services

This means React Flow is a rendering boundary, not the source of truth.

## Execution Flow

The execution pipeline is centralized in `src/lib/workflow/services/workflow-execution-service.ts`.

The pipeline is:

1. Read the latest snapshot from the store
2. Resolve execution targets
3. Validate the document and execution subgraph
4. Evaluate upstream dependencies recursively
5. Coerce prompt and image inputs into runtime values
6. Expand iterator batches if needed
7. Execute generator requests
8. Persist outputs into the document
9. Update runtime status and activity

Important rule:

- components and random hooks should not call generation directly

All workflow execution should enter through `WorkflowExecutionService.run()`.

## Persistence and Versioning

The workflow document is versioned.

Current version:

- `WORKFLOW_DOCUMENT_VERSION = 3`

Loader behavior:

- normalize current data
- reset incompatible or malformed persisted data
- fall back to the default graph if nothing usable exists

When node shape changes:

1. update `WorkflowDocumentNode` types
2. update default creation in `makeWorkflowNode()`
3. update normalization in `normalizeWorkflowNode()`
4. bump `WORKFLOW_DOCUMENT_VERSION` when the persisted shape breaks compatibility

Do not skip normalization. It is part of the persistence contract.

## How To Place New Changes

### Adding a new node kind

Touch these areas in order:

1. `src/lib/workflow/types.ts`
2. `src/lib/workflow/document.ts`
3. `src/lib/workflow/node-definitions.ts`
4. `src/lib/workflow/graph.ts` if graph semantics change
5. `src/lib/workflow/workflow-graph-validator.ts`
6. `src/lib/workflow/services/node-services.ts`
7. `src/lib/workflow/services/workflow-execution-service.ts` if it executes
8. `src/components/workflow/studio/nodes.tsx`

### Adding a persisted field

Put it in the document layer, not editor/runtime.

Then update:

1. document types
2. default node creation
3. normalization
4. migration if older data should be upgraded

### Adding a UI-only concern

Put it in `WorkflowEditorState`.

Examples:

- selection
- temporary layout metadata
- measured dimensions

### Adding an execution-only concern

Put it in `WorkflowRuntimeState`.

Examples:

- running status
- transient error text
- current activity message

### Changing graph behavior

If the change is structural or rule-based, start in:

- `workflow-engine.ts`
- `graph.ts`
- `node-definitions.ts`
- `workflow-graph-validator.ts`

### Changing business mutations

If the change is node-specific but not structural, start in:

- `src/lib/workflow/services/node-services.ts`

### Changing side effects

If the change talks to the network, storage, uploads, or model execution, start in:

- `workflow-client.ts`
- `workflow-asset-service.ts`
- `workflow-execution-service.ts`

## Common Pitfalls

### Do not persist React Flow objects directly

The document should remain UI-independent.

### Do not store transient runtime status in the document

`running`, `success`, `error`, and activity text belong in runtime state.

### Do not put business mutation lambdas in components

Move them into node services or the engine.

### Do not bypass execution validation

If something can run, it should pass through `WorkflowGraphValidator` first.

### Do not forget editor-only React Flow measurements

Controlled React Flow nodes need measured dimensions to stay visible.

## Current Extension Points

These are the most natural next additions to this architecture:

- undo/redo around engine mutations
- document import/export
- richer validation messages and UI surfacing
- more node kinds using the same service pattern
- server-backed workflow persistence once local-only storage is no longer enough

## Rule of Thumb

Before writing code, ask one question:

- Is this durable data, editor UI state, runtime state, a pure graph rule, or a side effect?

Once that is clear, the correct file usually becomes obvious.
