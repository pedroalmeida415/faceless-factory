# Tech Debt Todo

- [x] Unify workflow upstream dependency traversal.
  Pricing (`src/lib/workflow/pricing.ts`) walks upstream to collect cost-contributing generator nodes, while execution (`src/lib/workflow/execution/core.ts` and `src/lib/workflow/execution/input-coercion.ts`) walks upstream to resolve and run dependencies. Extract a shared helper/source of truth for upstream execution dependency discovery so pricing, validation, and execution cannot drift.
- [ ] Remove `// @ts-nocheck` from lane recovery service tests.
  `src/server/workflow/execution-service.test.ts` currently disables type checking for the new `startRun` lane-reuse coverage. Type the mocked Effect services and queue job assertions so the test itself complies with the project's strict TypeScript standard.
- [ ] Add DB-backed lane recovery artifact-store tests.
  Cover terminal-run filtering for prior lane reuse candidates, exclusion of active queued/running/waiting runs, exclusion of the newly created run, and transaction rollback for reusable lane seeding so partial copy failures cannot create misleading latest lane state.
- [ ] Split lane recovery service coverage into focused scenarios.
  Add separate service-level tests for terminal success reuse, active-run exclusion, seed failure cleanup/terminal error behavior, latest-error regeneration, and quote/debit excluding reused lanes instead of relying only on one combined mocked `startRun` scenario.
