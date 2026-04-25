# Tech Debt Todo

- [x] Unify workflow upstream dependency traversal.
  Pricing (`src/lib/workflow/pricing.ts`) walks upstream to collect cost-contributing generator nodes, while execution (`src/lib/workflow/execution/core.ts` and `src/lib/workflow/execution/input-coercion.ts`) walks upstream to resolve and run dependencies. Extract a shared helper/source of truth for upstream execution dependency discovery so pricing, validation, and execution cannot drift.
