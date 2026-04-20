# Server-Driven Workflow Execution Plan

## Goal

Move workflow execution from the browser to the server so that the server becomes the authoritative owner of:

1. execution planning
2. graph validation before run
3. dependency traversal
4. iterator expansion and batching
5. prompt and media input coercion
6. model invocation
7. credit enforcement
8. run status tracking
9. durable workflow output persistence

This change is required to support a real credit system safely and to avoid duplicating execution logic between client and server.

## Implementation Status

Status as of 2026-04-19.

Completed:

1. Shared execution core extracted into `src/lib/workflow/execution/`.
2. Server-side workflow execution service added in `src/server/workflow/execution-service.ts`.
3. In-memory run store added in `src/server/workflow/run-store.ts`.
4. Workflow-level start API added in `src/server/api/routers/workflow.ts` via `startExecution`.
5. Client execution path switched away from per-generation tRPC mutations.
6. Client store now hydrates authoritative server runtime/document state.
7. SSE transport added at `src/app/api/workflow-runs/[runId]/events/route.ts` and is now the primary runtime update path.
8. Initial server-side pricing and in-memory credits services added in `src/server/workflow/pricing.ts` and `src/server/workflow/credits.ts`.
9. `startExecution`, `getCredits`, and SSE run access now require authenticated user ownership.

Partially completed:

1. Phase 4 is functionally in place for run/start and runtime hydration, but cleanup/docs/tests are still pending.
2. Phase 3 is functionally in place with in-memory pricing/credits enforcement, but durable balances, persistence, and test coverage are still pending.

Not completed:

1. cancellation
2. durable run persistence
3. server-backed workflow persistence
4. dedicated tests for the new server execution path

## New Session Pickup

If a future session continues this work, start here:

1. add cancellation support to the run store, execution service, and SSE stream
2. add integration tests for shared execution, async run status, and SSE delivery
3. update `WORKFLOW_ARCHITECTURE.md` to describe the new server-driven path, SSE transport, and credit enforcement

Current authoritative execution flow:

1. client sends document snapshot to `workflow.startExecution`
2. server creates a run record and starts async execution
3. client opens SSE stream at `/api/workflow-runs/[runId]/events`
4. server pushes runtime/document updates from the run store
5. client hydrates Zustand from streamed server state

## Current State

The repo already has a clean split between shared workflow domain code and client-side orchestration, but the orchestration still lives in the browser.

Current client-owned execution path:

1. UI calls `WorkflowExecutionService.run()`
   - `src/lib/workflow/services/workflow-execution-service.ts`
2. The client reads the latest snapshot from Zustand
   - `src/lib/workflow/services/workflow-studio-store-service.ts`
   - `src/components/workflow/studio/store.ts`
3. The client validates the execution graph
   - `src/lib/workflow/workflow-graph-validator.ts`
4. The client recursively evaluates upstream nodes
   - `src/lib/workflow/services/workflow-execution-service.ts`
5. The client expands iterator/media batches
   - `src/lib/workflow/graph.ts`
6. The client calls server generation mutations one request at a time
   - `src/lib/workflow/services/workflow-client.ts`
   - `src/server/api/routers/workflow.ts`
7. The client persists generated outputs back into the local document
   - `src/components/workflow/studio/store.ts`
   - `src/lib/workflow/services/workflow-persistence-service.ts`

Current server-owned responsibilities:

1. asset storage
   - `src/server/workflow/storage.ts`
2. model execution against Vertex AI
   - `src/server/workflow/vertex.ts`
3. tRPC transport and auth context
   - `src/server/api/trpc.ts`
   - `src/server/api/routers/workflow.ts`

## Architecture Decision

We should move to workflow-level server execution, not just per-generation credit checks.

Recommended target:

1. The client sends a workflow document plus execution target information to the server.
2. The server validates the document and executes the workflow.
3. The server returns:
   - updated workflow document
   - run metadata
   - per-node runtime state snapshot
   - credit balance summary
4. The client treats the server response as authoritative and hydrates local UI/runtime state from it.

## Recommendation On Persistence Scope

There are two possible server-driven models.

### Option A

Server-driven execution with client-supplied document snapshots.

1. The browser remains the editor of the workflow document.
2. The client sends the current document to the server for execution.
3. The server runs that exact document and returns an updated document.

Pros:
- smallest path to server-owned execution
- no immediate need to build server workflow persistence
- preserves current local-first editor model

Cons:
- workflow document is still not server-authoritative at rest
- collaboration and resumable runs remain harder
- future multi-device continuity is limited

### Option B

Fully server-persisted workflow documents plus server-driven execution.

1. The browser edits a server-backed workflow document.
2. The server owns load/save/versioning/execution.
3. The client becomes a thin editor/view over server data.

Pros:
- best long-term architecture
- natural foundation for credits, authz, history, collaboration, resumable runs
- removes localStorage from the source-of-truth path

Cons:
- larger initial scope
- requires new persistence model and sync contract

### Recommendation

Implement this in two phases:

1. Phase 1: server-driven execution with client-supplied document snapshots
2. Phase 2: move workflow persistence from localStorage to the server

This keeps execution and credits on the server immediately while avoiding an unnecessarily large first migration.

## Design Principles

1. Keep workflow domain logic shared when it is pure.
2. Move orchestration and side effects to server adapters.
3. Do not duplicate batching, coercion, or validation logic.
4. Keep editor-only concerns on the client.
5. Keep runtime execution state out of the persisted document.
6. Preserve the existing `document` normalization and versioning contract in `src/lib/workflow/document.ts`.
7. Make credits enforceable only at the workflow execution boundary on the server.

## Shared Code To Keep

These modules should remain shared between client and server:

1. `src/lib/workflow/types.ts`
2. `src/lib/workflow/document.ts`
3. `src/lib/workflow/graph.ts`
4. `src/lib/workflow/generator-models.ts`
5. `src/lib/workflow/workflow-graph-validator.ts`
6. `src/lib/workflow/services/node-services.ts`
7. `src/lib/workflow/errors.ts`

These are already the correct home for durable schema, graph semantics, request building, and pure business rules.

## Code That Must Stop Owning Execution

The following modules currently own execution logic in the wrong environment and need to be reduced or replaced:

1. `src/lib/workflow/services/workflow-execution-service.ts`
2. `src/lib/workflow/services/workflow-client.ts`
3. `src/lib/workflow/services/workflow-studio-store-service.ts`
4. `src/components/workflow/studio/runner/index.ts`
5. `src/components/workflow/studio/useWorkflowStudioController.ts`

The client should no longer recursively execute the graph or call model generation procedures directly.

## Target Module Layout

### Shared Execution Core

Add a shared execution core in `src/lib/workflow/execution/`.

Recommended files:

1. `src/lib/workflow/execution/core.ts`
2. `src/lib/workflow/execution/types.ts`
3. `src/lib/workflow/execution/target-resolution.ts`
4. `src/lib/workflow/execution/input-coercion.ts`
5. `src/lib/workflow/execution/runtime-state.ts`

Responsibilities:

1. resolve execution targets
2. recursively evaluate dependencies
3. coerce prompt/media inputs
4. integrate iterator/media batch planning
5. describe runtime node transitions in a transport-safe format
6. remain side-effect free except through injected ports

### Server Execution Adapter

Add server-side workflow execution in `src/server/workflow/`.

Recommended files:

1. `src/server/workflow/execution-service.ts`
2. `src/server/workflow/execution-ports.ts`
3. `src/server/workflow/run-store.ts`
4. `src/server/workflow/credits.ts`
5. `src/server/workflow/pricing.ts`

Responsibilities:

1. adapt the shared execution core to actual server side effects
2. call `VertexAi` directly instead of going back through client RPC wrappers
3. enforce credits before and during execution
4. persist generated assets and updated workflow state
5. track run state for SSE delivery and future resume/status lookup

### API Layer

Extend `src/server/api/routers/workflow.ts` to add workflow-level procedures.

Recommended procedures:

1. `startExecution`
2. `GET /api/workflow-runs/[runId]/events`
3. `getCredits`
4. optionally `validateDocument`

The existing `generateImage` and `generateVideo` procedures should become private implementation details or be removed after migration if nothing else needs them directly.

## Execution Request Contract

Add shared request and response types in `src/lib/workflow/types.ts` or a new `src/lib/workflow/execution/types.ts`.

Recommended request shape:

1. `document`
2. `target`
3. `clientRunId`
4. optional `selection`
5. optional `documentVersion`
6. optional `idempotencyKey`

Recommended `target` variants:

1. `selected-or-all`
2. `node`
3. optionally `nodes`

Important note:
The server cannot infer client editor selection state, so selection must be sent explicitly in the request.

Recommended response shape:

1. `runId`
2. `document`
3. `runtime`
4. `activity`
5. `credits`
6. `status`

Recommended `runtime` payload:

1. `nodeStateById`
2. `activity`
3. `startedAt`
4. `finishedAt`
5. `error`

## Runtime State Model

The persisted document should remain durable-only.

Execution-only state should be returned separately and continue to map into `WorkflowRuntimeState`.

Server run status needs a transport-safe format similar to the existing client runtime shape:

1. node status: `idle | running | success | error`
2. node error message
3. global activity string
4. run status: `queued | running | success | error`
5. timestamps

This state may be transient in memory for Phase 1.

## Credit Integration Strategy

Credits should be enforced inside the new server workflow execution service.

Recommended credit model for this phase:

1. fixed cost per generator request
2. image cost based on model
3. video cost based on model and optionally duration/resolution
4. total cost computed from expanded batch plan before execution starts

Recommended flow:

1. server receives workflow execution request
2. server validates document
3. server resolves execution target
4. server computes expanded execution plan
5. server prices the full run
6. server checks and reserves credits
7. server executes the run
8. server finalizes or refunds unused reserved credits if needed
9. server returns updated balances

This is the main reason to centralize execution.

## Pricing Placement

Add a single server-side pricing module.

Recommended file:
`src/server/workflow/pricing.ts`

Responsibilities:

1. map generator settings to per-iteration price
2. compute total run cost from expanded execution plan
3. keep all pricing rules out of the client
4. support future model-level pricing changes without touching UI code

## Credits Placement

Add a dedicated server-side credit service.

Recommended file:
`src/server/workflow/credits.ts`

Responsibilities:

1. get available credits for a user
2. reserve credits for a run
3. settle credits on success
4. refund or partially refund on failure or cancellation
5. expose balance summary for the response payload

This module should hide the eventual DB schema details from the execution service.

## Server Run Store

Add a transient run store for Phase 1.

Recommended file:
`src/server/workflow/run-store.ts`

Responsibilities:

1. create run records keyed by `runId`
2. update node-level runtime state during execution
3. publish runtime updates to SSE subscribers
4. handle completion and failure state

Phase 1 implementation options:

1. simple in-memory store
2. durable DB-backed run state if long-running jobs are needed immediately

Recommendation:
start with in-memory only if execution stays request-response and short-lived enough.
If video runs will regularly exceed request limits, skip directly to durable run state and async jobs.

## Synchronous vs Asynchronous Execution

This is the largest runtime tradeoff.

### Synchronous

The `execute` procedure performs the full run and returns only when complete.

Pros:
- simplest first implementation
- easiest to integrate with current UI

Cons:
- long-running video jobs are risky
- request timeout risk
- harder cancellation story

### Asynchronous

The `execute` procedure creates a run and returns quickly, then the client subscribes to server updates.

Pros:
- safer for long-running video generation
- better foundation for progress UI
- natural for cancellation and retries

Cons:
- more moving parts immediately

### Recommendation

Use asynchronous workflow execution from the start.

Reason:
`src/server/workflow/vertex.ts` already polls Veo operations for up to six minutes. A synchronous tRPC mutation is fragile for this case.

Recommended procedure set:

1. `startExecution`
2. SSE stream at `/api/workflow-runs/[runId]/events`
3. optionally `cancelExecution`

## Detailed Migration Phases

## Phase 1

Extract shared execution logic.

Work items:

1. Split `src/lib/workflow/services/workflow-execution-service.ts` into:
   - pure execution core
   - client adapter responsibilities
2. Move target resolution, recursive evaluation, batching integration, and input coercion into shared modules.
3. Define execution ports for:
   - generator execution
   - runtime reporting
   - document mutation
   - credit reservation
4. Keep behavior identical to current execution logic.

Files primarily affected:

1. `src/lib/workflow/services/workflow-execution-service.ts`
2. new `src/lib/workflow/execution/*`

Acceptance criteria:

1. no logic duplication between future client and server execution
2. existing behavior preserved under tests

## Phase 2

Add server execution adapter and workflow-level API.

Work items:

1. implement `src/server/workflow/execution-service.ts`
2. wire direct model calls to `VertexAi`
3. wire asset storage through `WorkflowStorage`
4. implement `startExecution`
5. implement SSE transport for async runtime updates
6. add shared request/response schemas

Files primarily affected:

1. `src/server/api/routers/workflow.ts`
2. `src/server/workflow/execution-service.ts`
3. `src/server/workflow/run-store.ts`
4. `src/server/workflow/vertex.ts`
5. `src/lib/workflow/types.ts` or new shared execution type file

Acceptance criteria:

1. client no longer calls per-generation tRPC mutations for workflow runs
2. server can execute image and video generator nodes from a document snapshot
3. server returns runtime status and updated document

## Phase 3

Add credits to the server execution boundary.

Work items:

1. implement pricing module
2. implement credit service
3. require authenticated execution
4. reserve credits before run
5. settle credits after run
6. return updated credit summary in run status and completion payloads

Files primarily affected:

1. `src/server/api/trpc.ts`
2. `src/server/api/routers/workflow.ts`
3. `src/server/workflow/pricing.ts`
4. `src/server/workflow/credits.ts`

Acceptance criteria:

1. insufficient credits prevent server execution
2. client-side low-credit checks are advisory only
3. server remains authoritative for final billing

## Phase 4

Switch client UI to the new execution API.

Work items:

1. replace current runner entrypoints with calls to `startExecution`
2. subscribe to SSE execution updates
3. hydrate returned runtime state into Zustand
4. hydrate returned updated document into Zustand
5. remove direct dependence on `WorkflowClientService.generateImage/generateVideo`
6. keep current UI feedback and node status behavior

Files primarily affected:

1. `src/components/workflow/studio/runner/index.ts`
2. `src/components/workflow/studio/useWorkflowStudioController.ts`
3. `src/components/workflow/studio/store.ts`
4. `src/lib/workflow/services/workflow-client.ts`

Acceptance criteria:

1. run button behavior remains familiar
2. node statuses still update visibly
3. errors map cleanly into existing runtime UI

## Phase 5

Remove obsolete client-driven execution code.

Work items:

1. delete or reduce `WorkflowExecutionService` client orchestration
2. remove direct client generation wrappers if no longer needed
3. remove public generation mutations if nothing else uses them
4. update architecture docs

Files primarily affected:

1. `src/lib/workflow/services/workflow-execution-service.ts`
2. `src/lib/workflow/services/workflow-client.ts`
3. `WORKFLOW_ARCHITECTURE.md`

Acceptance criteria:

1. only one workflow execution path remains
2. docs describe server-driven execution accurately

## Optional Phase 6

Move workflow persistence to the server.

Work items:

1. add workflow repository and DB schema
2. load/save workflow documents through API
3. move away from localStorage as the source of truth
4. keep local draft caching only as a UX optimization

Files primarily affected:

1. `src/server/db/schema.ts`
2. `src/server/workflow/repository.ts`
3. `src/lib/workflow/services/workflow-persistence-service.ts`
4. `src/components/workflow/studio/store.ts`

Acceptance criteria:

1. workflow documents survive browser/device changes
2. execution always runs against server-persisted documents when desired

## API Plan

Recommended new router structure in `src/server/api/routers/workflow.ts`:

1. `startExecution`
2. `GET /api/workflow-runs/[runId]/events`
3. `cancelExecution`
4. `getCredits`
5. `uploadAsset`

Recommended auth policy:

1. `startExecution` should be `protectedProcedure`
2. `cancelExecution` should be `protectedProcedure`
3. `getCredits` should be `protectedProcedure`

If anonymous workflows must remain supported, that should be an explicit later exception, not the default.

## Client State Integration Plan

The client store should remain responsible for:

1. editor state
2. selection state
3. measured node dimensions
4. rendering runtime information returned by the server

The client store should stop being responsible for:

1. recursive execution traversal
2. iterator expansion for execution
3. model invocation decisions
4. final credit availability decisions

Recommended store additions:

1. `activeRunId`
2. `lastServerRuntime`
3. `lastExecutionFinishedAt`
4. execution streaming flags

Recommended store mutations:

1. `applyServerExecutionState`
2. `applyServerDocument`
3. `setActiveRunId`
4. `clearActiveRunId`

## Error Model Plan

Keep existing workflow error types where possible, but add explicit server execution failures.

Recommended additions:

1. `WorkflowCreditsError`
2. `WorkflowRunNotFoundError`
3. `WorkflowAuthorizationError`

Server responses should preserve user-meaningful messages while keeping internal causes structured.

## Testing Plan

## Unit Tests

Add tests for shared execution core covering:

1. prompt dependency resolution
2. asset dependency resolution
3. iterator/media batch expansion
4. target resolution
5. validation failures
6. generator result application back into document
7. pricing calculation from expanded plan

## Integration Tests

Add server integration tests covering:

1. `startExecution` for image workflows
2. `startExecution` for video workflows
3. insufficient credits rejection
4. run status transitions
5. returned runtime state shape
6. returned updated document shape

## Client Integration Tests

Add UI-oriented tests covering:

1. run button starts server execution
2. SSE updates node statuses
3. insufficient credits surface properly
4. returned generated assets appear in the studio
5. existing runtime activity UI still works

## Manual Verification

Manual checks:

1. single image generator run
2. image generator with multiple reference images
3. selected-node execution
4. selected-or-all execution
5. video generator with long-running generation
6. failure propagation from model errors
7. low credits and zero credits paths
8. cancellation behavior if implemented

## Data And Contract Risks

1. The server cannot see editor selection unless the request includes it.
2. The current localStorage document is not server-authoritative.
3. Long-running video generation may force async jobs immediately.
4. Runtime state must not accidentally leak into the persisted document.
5. Asset references in execution requests must always be server-readable persisted assets, never raw browser `File` objects.
6. The shared execution core must be extracted before major feature work to avoid duplicate logic.

## Non-Goals For This Migration

1. bucketed workspace/monthly/rollover/extra credits
2. multi-user collaboration
3. server-side workflow persistence if Phase 1 snapshot execution is used first
4. billing provider integration details
5. full bidirectional transport beyond SSE if SSE is sufficient initially

## Suggested Implementation Order

1. extract shared execution core
2. define workflow execution request/response contracts
3. implement server execution service
4. add async run store and SSE/status delivery
5. switch client runner to new API
6. add server-side pricing and credits
7. remove obsolete client-driven execution path
8. update architecture docs
9. optionally add server-backed workflow persistence

## Expected End State

After this migration:

1. the browser edits workflows
2. the server executes workflows
3. credits are enforced only on the server
4. batching and validation logic exist only once
5. runtime status is server-derived and client-rendered
6. future server-backed persistence becomes a straightforward follow-up rather than another architectural rewrite
