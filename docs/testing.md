# Testing

## Runtime Contract Suite

The `Runtime Contract Suite` is the behavioral backbone for the Task state machine. It is a contract test suite: it defines the runtime behaviors and invariants the product must preserve across features, bug fixes, and refactors.

Run it with:

```bash
bun run test:runtime-contract
```

The suite lives in `src/features/runtime/contract.test.ts`, with the reusable PGLite database Layer in `src/server/services/database.ts` and invariant assertions in `src/features/runtime/contract-harness.ts`. Runtime tests must never connect to the app `DATABASE_URL`; destructive setup such as truncate/delete is only valid against this isolated PGLite Layer.

This is not a smoke test. A smoke test only proves a path basically starts. This suite exercises the real runtime seams deeply enough to catch product-breaking behavior regressions:

- `planWorkflowRun`
- Task Input Materialization
- runtime repository and Wake-Up Call gatekeeper transactions
- active-slot uniqueness through the test database schema
- provider executor snapshot consumption
- runtime queue job payload contracts
- task projection and studio projection
- save-lock policy

Any change touching runtime behavior must keep this suite green. This includes changes under:

- `src/features/runtime/**`
- `src/features/runtime/server/**`
- `src/features/runtime/materialization/**`
- `src/features/workflow/pricing.ts`
- `src/features/workflow/save-lock-policy.ts`
- `src/features/workflow/server/projects.ts`
- `src/components/workflow/studio/**`

When a runtime bug is found, add or extend a contract scenario before fixing it when the behavior belongs to the Task state machine. The scenario name should describe user-visible behavior, not private helper mechanics.

## Contract Suite Candidates

The runtime suite protects the core product state machine. Other domains that should eventually get contract suites are:

- `Workflow Studio Contract Suite`: editor graph operations, save behavior, projection hydration, undo/redo, node deletion/recreation, selection-only edits, and React Flow canvas synchronization.
- `Billing And Credits Contract Suite`: credit ledger debit/refund invariants, subscription changes, reservation reconciliation, insufficient-credit UX states, and final-cost attribution.
- `Provider Adapter Contract Suite`: Vertex/Gemini request construction, idempotency keys, abort handling, typed failure mapping, media upload handoff, and no raw provider payload leakage.
- `Asset Catalog Contract Suite`: uploaded/generated asset ownership, workflow-local authorization, CDN payload shape, generated text storage, producing Task links, and deletion safety.
- `Workflow Event Stream Contract Suite`: tRPC SSE authorization, Redis Pub/Sub delivery, attempt-aware stale event handling, reconnect behavior, and renderable event payloads.

Add these only when they can test real seams. A contract suite should be a stable behavioral specification, not a collection of helper unit tests.
