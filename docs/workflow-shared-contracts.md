# Workflow Shared Contracts

This document captures contracts shared by backend runtime, transport, and frontend projection work. These contracts should be implemented before independently building the server runtime and graph UI.

## First Vertical Contract: Graph Blueprint And Input Alignment

The first shared contract is the persisted Graph Blueprint schema plus a deterministic Input Alignment evaluator.

The Graph Blueprint contract defines authored workflow state: nodes, edges, node positions, input values, generation node model IDs, model config, selected batch items for generated outputs, and graph revision metadata.

The Input Alignment evaluator consumes a Graph Blueprint, Model Catalog, and execution/result references when needed, then returns the frontend/runtime-safe facts for each Generation Node: required input validation, optional input participation, repeatable socket capacity use, Branch Count, Branch-level resolved values, total output count, deterministic Generation Cost inputs, stale fingerprint material, and blocking errors.

The evaluator must be deterministic, side-effect free, and independent of provider/runtime execution. It should live as a shared pure TypeScript domain module used by both server and client, while the server remains authoritative for persisted Graph Revisions, runtime Task creation, and execution projections. Backend runtime uses it to create branch-level Tasks and dependencies; frontend uses it for responsive previews and to render projected validation, branch counts, costs, stale badges, and socket state.

The evaluator returns separate views of the same decision:

- `summary`: Branch Count, total output count, deterministic Generation Cost inputs, and validation status.
- `inputStates`: per-socket state such as missing, ignored optional No Value, broadcasting, zipping, mismatched, and capacity usage.
- `branches`: resolved per-Branch input references for runtime Task creation, without embedding heavy media payloads.
- `fingerprintMaterial`: canonical material graph/config values used for stale-result comparison.

Branch input references should be discriminated by `kind` so consumers can safely distinguish text values, asset references, and generated-output references. Generated-output references use the upstream `nodeId` plus `branchIndex`; the selected Batch Item is resolved from the upstream node's selected-output state.

Contract indexes are zero-based, including `branchIndex`; UI labels are one-based, such as `Branch 1 of 3`.

Graph Blueprint node IDs and edge IDs are client-generated stable opaque IDs. The server validates and persists them but does not assign new IDs on save.

The Graph Blueprint stores React Flow-compatible node and edge fields directly instead of mapping them into a separate domain graph shape. Runtime code should still consume validated business fields from the blueprint rather than depending on React Flow rendering behavior.

Graph Blueprint includes an explicit numeric `schemaVersion` for validation and future migrations. The initial schema version is `1`.

The executable contract lives in `src/features/workflow/domain/workflow.ts` with focused coverage in `src/features/workflow/domain/workflow.test.ts`.

## Out Of Scope For This Contract

- Runtime Task persistence tables.
- Worker scheduling.
- Provider execution.
- Debit/refund ledger behavior.
- SSE event envelope details beyond knowing that projections can be updated granularly.
