Repository instructions for coding agents. Follow system/developer/user instructions first. This file defines repo-specific engineering standards, scope discipline, and verification expectations.

## 1. Load order and task routing

Before non-trivial implementation, read:
- `CONTEXT.md` when present.
- Relevant `docs/adr/**` records when architecture, persistence, runtime, or domain vocabulary is involved.
- Relevant `docs/agents/**` files only when triggered below.

For complex features or significant refactors, create or update an execution plan before implementation when the user requests planning or when the work spans multiple domains.

## 2. Core decision hierarchy

When rules conflict, use this order:
1. Correctness, security, and data integrity.
2. Root-cause fixes and shared domain invariants.
3. Architecture that improves locality, leverage, and testability.
4. Type safety, explicit error modeling, and resource safety.
5. Minimal code surface area.
6. Speed of delivery.

Move fast by choosing direct architecture and avoiding unnecessary compatibility code. Do not move fast by faking persistence, execution, validation, idempotency, typed errors, or verification.

## 3. Scope discipline

Solve the task at the correct architectural level. Do not silently implement a smaller substitute.

Inside the touched invariant path:
- Fix root causes, not symptoms.
- Delete obsolete or duplicated logic before adding new abstractions.
- Consolidate duplicated rules into one source of truth.
- Leave the touched domain cleaner, more typed, and easier to verify.

Outside the touched path:
- Do not expand scope into unrelated systems.
- Mention notable unrelated issues only when useful.

Prototype data may be broken. Architecture may not be faked. Local/staging Postgres, Redis, and BullMQ state may be invalidated during MVP refactors when this produces a cleaner system.

## 4. Architecture standards

Prefer deep modules: small stable interfaces that hide substantial behavior. Avoid shallow modules that merely rename, forward, or scatter rules.

Before adding a seam, port, adapter, service, wrapper, or helper:
- Apply the deletion test.
- Identify the source of truth.
- Identify the dependency category.
- Confirm whether the seam has at least two justified adapters, usually production plus test.
- Keep internal seams internal unless callers truly need variation.

Do not create thin wrappers around single calls, tiny config projections, or same-scope layer factories unless the abstraction owns meaningful validation, policy, lifecycle, telemetry, resource ownership, or repeated multi-step behavior.

Composition files should show real runtime wiring. If composition becomes too large, deepen the underlying services or split by lifecycle/domain ownership instead of hiding wiring behind pass-through factories.

## 5. TypeScript and Effect

Use TypeScript strictly:
- No `any`.
- Avoid `as`; prefer schemas, narrowing, discriminated unions, `satisfies`, and typed constructors.
- Read environment variables through `src/env.js` / `~/env`, not raw `process.env`, except in env bootstrap or documented third-party interop.

Use Effect when code crosses seams, performs I/O, manages resources, coordinates concurrency, schedules work, streams data, retries, observes telemetry, or models recoverable failure.

Use plain TypeScript for deterministic in-memory transforms with no I/O, lifecycle, concurrency, recoverable errors, or dependency requirements.

Do not use raw Promise orchestration, thrown domain errors, nullable failure sentinels, or ad hoc `try/catch` in domain, application, persistence, queue, worker, or provider integration code. Use Effect programs, tagged errors, managed resources, timeouts, interruption, and typed recovery.

When asynchronous coordination needs shared readiness, single-flight initialization, fan-out, cancellation, or lifecycle cleanup, model it with Effect primitives instead of hidden promise state. Prefer `Deferred`, `Ref`, `Queue`, `PubSub`, `Scope`, `Fiber`, and `Effect.acquireRelease` so fallibility, interruption, and cleanup are visible in types. Do not hide errors in plain `async` helpers, `.then/.catch` chains, or callback-local `try/catch`; return an `Effect` with typed errors and compose cleanup with `Effect.tapError`, finalizers, or scoped resources.

For shared external subscriptions, use one managed underlying connection/subscription per process or layer and multiplex local handlers explicitly. Track channel/topic handlers in scoped state, use `Deferred` for pending subscribe readiness so concurrent callers share the same in-flight subscribe attempt, and unsubscribe from the external system only after the last local handler is released.

Before implementing or changing non-trivial Effect code, inspect the local Effect source at: ~/.local/share/effect-solutions/effect

Match the installed package version and local project patterns.

## 6. Service and boundary rules

Follow `docs/adr/0001-feature-clean-architecture-boundaries.md` for feature and core boundaries.

Feature modules use:

src/features/<feature>/domain/**
src/features/<feature>/application/**
src/features/<feature>/infra/**

Global technical capabilities use:

src/core/application/**
src/core/infra/**

Root composition and framework adapters use:

src/main/**

Feature `domain` contains business rules, domain errors, value objects, domain services, and business protocols. Feature `application` contains use cases, orchestration, and feature-owned ports/contracts. Feature `infra` implements feature application ports using external libraries, SDKs, databases, queues, framework mechanisms, and `core/application` ports.

Feature application modules use stable top-level contracts such as `errors.ts`, `models.ts`, and capability ports like `store.ts`, plus procedure-aligned use cases under `application/use-cases/<procedure-name>.ts`. Do not create use-case service tags or `*Live` layers for stable use cases; export the Effect program directly. Name feature application ports by capability, not `ports.ts`, and mirror that capability in infra adapter filenames such as `infra/store.ts`; reserve `Live` for concrete Layer values.

Feature domain modules should be split by domain concept or invariant owner, for example `graph.ts`, `graph-evaluation.ts`, and `model-catalog.ts`. Avoid permanent catch-all files such as `domain/<feature>.ts`, `types.ts`, `utils.ts`, or `schemas.ts`. Keep deterministic in-memory domain rules as pure TypeScript functions; call them from Effect use cases/adapters when I/O or orchestration is needed.

Feature infra adapters translate infrastructure failures at the adapter method boundary into feature-level application errors. Prefer catching specific tagged infrastructure errors, such as `Effect.catchTag("SqlError", ...)`, over broad `mapError` helpers that catch every error and then special-case feature errors. Intentional feature errors emitted by adapter logic should pass through unchanged.

Feature application should depend on feature domain and feature-owned ports expressed in business/use-case language. Feature application should not import shared infrastructure implementations, and should not depend directly on generic core capability ports by default.

Feature infra may depend on feature application and `core/application`. Feature infra must not depend on `core/infra`, and must not bypass feature application by implementing domain ports directly.

Core application ports are broad but cohesive technical capabilities, such as database, job queue, object storage, pub/sub, AI generation, and payment gateway. Core ports must use generic capability language, not feature-specific nouns.

Core infra implements core application ports. Feature-shaped services must not be moved into core as-is; translate feature language to core capabilities in feature infra.

Capability service tags use capability names with `Service`, for example `DatabaseService`, `JobQueueService`, `ObjectStorageService`, `PubSubService`, `AiGenerationService`, or `PaymentGatewayService`. Do not prefix capability services with `Server`, deployment tier names, or the first feature that used them.

External provider services expose capability methods such as `generateText`, `generateImages`, `generateVideo`, `storeAsset`, or `chargeCredits`. Pass model/config as data. Do not create public model-specific methods.

Provider services own reusable SDK clients. Construct and validate clients in service layers, cache by durable config key when needed, and centralize request lifecycle behavior: validation, normalization, media conversion, idempotency metadata, timeout/cancellation, telemetry, error mapping, response extraction, and artifact staging.

`ManagedRuntime.make` may only be called from:

* `src/client/effect.ts`
* `src/main/effect.ts`

Root composition belongs in `src/main/**`. App code and tests must reuse central runtimes.

## 7. Bug fixing

For non-trivial bugs:

1. Trace the full lifecycle through persistence, execution, validation, UI, and synchronization as applicable.
2. Search for all callers that compute or depend on the same domain concept.
3. Treat duplicated or divergent logic as a likely root cause.
4. Consolidate the invariant into one source of truth.
5. Delete obsolete paths after replacement coverage exists.
6. Verify the architectural path, not only the symptom.

Final response for non-trivial bug fixes must state:

* Root cause.
* Shared invariant or source of truth introduced or reused.
* Duplicated/divergent paths removed.
* Subsystems now consuming the same logic.
* Verification performed.
* Whether any temporary workaround remains.

## 8. UI and Next.js

Use Next.js App Router correctly:

* Route files compose, load data, and wire seams.
* Non-trivial feature implementation lives under `src/features/<domain>/` or the existing project equivalent.
* Do not mix UI rendering, domain transitions, persistence schemas, queue orchestration, and mock data in one file.

For user-facing async UI, include appropriate loading, transition, error, and empty states consistent with the design system.

Use Zustand for external state store when multiple components read or write the same client state. Use React Query/tRPC seams for server state, cache invalidation, optimistic updates, and typed API behavior.

## 9. Security, telemetry, and idempotency

Sanitize user inputs with schemas or typed API seams. Never log secrets, credentials, raw PII, raw prompts, sensitive payloads, or unredacted media.

Instrument durable seams and complex pipelines with spans, metrics, structured logs, and sanitized domain metadata. Prefer interface-level telemetry over noisy helper-level logs.

Use Effect observability primitives directly instead of adding generic telemetry facades. Use `Effect.logDebug`, `Effect.logInfo`, `Effect.logWarning`, `Effect.logError`, `Metric.*`, and Effect span APIs in the code that owns the operation. OpenTelemetry layers are runtime/export wiring only;

Effect spans are the primary observability primitive. Use `Effect.withSpan`, `Effect.functionWithSpan`, `Effect.annotateCurrentSpan`, and `Effect.withSpanScoped` at durable boundaries such as tRPC mutations, use cases, queue enqueue/dequeue, worker handlers, database transactions, pub/sub, blob storage, and provider calls. Use span names in `feature.component.action` form.

Use sanitized span attributes only. Prefer stable identifiers and operational metadata such as `job_id`, `provider`, `model`, `status`, and `attempt`. Never attach raw prompts, raw media, secrets, credentials, unredacted PII, or large payloads to spans, logs, metrics, or trace baggage.

End-to-end traces must survive async process boundaries. Any queue, worker, delayed job, pub/sub, webhook, or provider callback boundary that represents causally related work must propagate a typed trace-context carrier as operational metadata separate from the domain payload. Do not rely on Effect fiber-local span context surviving serialization, Redis, BullMQ, process restarts, or worker handoff.

Use W3C trace context for cross-boundary carriers: `traceparent`, optional `tracestate`, and optional `baggage` only when baggage is explicitly sanitized and justified. Enqueue/publish adapters should capture the current propagated span context and write the carrier; worker/subscriber adapters should extract the carrier before opening the processing span so the first worker span is a child of the remote parent. Missing or invalid trace context must not fail domain work; start a root span and record sanitized telemetry instead.

Prefer parent-child span propagation for direct causal work. Use span links instead of parent-child relationships for fan-out, retries, replay, wake-up calls, or any work item that is derived from multiple possible parents. Tests for queue, worker, and pub/sub adapters should cover trace-context injection/extraction when those adapters are touched.

BullMQ workers and generative provider calls must be idempotent. Use request IDs/correlation IDs and stable job IDs. Never use `:` in BullMQ custom `jobId` values; use existing builders and `~` as the structural delimiter.

All generative calls must support timeout/cancellation via `AbortSignal` or equivalent Effect interruption.

## 10. Commands

For formatting or safe lint fixes reported by `check`, run the repository fixer instead of manually editing formatting-only diffs:

```bash
rtk bun run check:write
```

Afterward, rerun `rtk bun run check` to verify the formatter/linter is clean.

Inspect local Postgres:

```bash
rtk docker exec faceless-factory-postgres-1 psql -U postgres -d faceless-factory -c "<sql>"
```

Inspect Redis/BullMQ:

```bash
rtk docker exec faceless-factory-redis-1 redis-cli <command>
```

## 11. Verification and final response

Non-documentation implementation work is not done until:

* Durable modules are split by domain capability.
* Core invariants are encoded in types or schemas.
* Execution, persistence, and UI paths touched by the change are exercised.
* Relevant checks pass, or inability to run them is explicitly reported.

Final response must include:

* What changed.
* Why the structural approach was chosen in 1–2 sentences when architecture changed.
* Verification commands and results.
* Any shortcuts, mocks, local-only state, missing persistence, missing worker/runtime behavior, or unimplemented parts.
* If none remain, state that no temporary workaround remains.

# Architecture Guide

Use this guide for architecture reviews, significant refactors, interface design, testability work, duplicated rules, confusing seams, and non-trivial implementation.

## Vocabulary

- Module: anything with an interface and implementation.
- Interface: everything a caller must know to use the module correctly: types, invariants, ordering, errors, config, performance, and lifecycle.
- Implementation: code inside the module.
- Depth: leverage at the interface.
- Seam: where behavior can vary without editing callers.
- Adapter: concrete implementation satisfying an interface at a seam.
- Leverage: capability gained per unit of interface understood.
- Locality: concentration of change, bugs, knowledge, and verification.

## Deepening process

1. Read `CONTEXT.md` and relevant ADRs.
2. Identify the source of truth and lifecycle.
3. Find duplicated rules and divergent paths.
4. Classify dependencies:
   - In-process
   - Local-substitutable
   - Remote but owned
   - True external
5. Apply the deletion test.
6. Prefer deepening existing modules over extracting helpers.
7. Keep internal seams internal.
8. Introduce public ports only when variation is real.
9. Test observable behavior through the module interface.
10. Delete helper-level tests after replacement behavior coverage exists.

## Interface design

For consequential public interface changes, compare 2–3 designs before implementing.

Evaluate each by:
- Depth
- Locality
- Seam placement
- Dependency category
- Adapter strategy
- Invariants
- Ordering constraints
- Error modes
- Caller ergonomics
- Verification path

Choose the design with the best leverage and locality, not the most abstract design.

# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```
Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

# Effect Guide

## Local Effect Source

The Effect repository is cloned outside this project at `~/.local/share/effect-solutions/effect`. Treat that external clone as the canonical local reference for Effect APIs, implementation details, and usage examples.

Agents must read `~/.local/share/effect-solutions/effect` before implementing or modifying Effect code, especially code involving `Effect`, `Layer`, `Context`, `Scope`, `Stream`, `Schedule`, `Runtime`, `Exit`, `Cause`, `Fiber`, resource lifecycles, typed errors, concurrency, retries, or service dependency injection. Prefer `Glob`, `Grep`, and targeted `Read` calls against `~/.local/share/effect-solutions/effect/packages/**` to find real examples and source definitions before designing local abstractions.

Do not invent Effect patterns from memory when the external clone can verify the API shape or idiom. If local project code and the external clone disagree, inspect both and choose the pattern that matches the installed package version or explicitly report the version mismatch.

When writing Effect code, inspect `~/.local/share/effect-solutions/effect` for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

## Rules

* Keep Effect values inside domain/application/infra code until the outer framework adapter runs them.
* Do not explicitly annotate Effect program return types unless necessary for exported API clarity; let inference expose requirements and errors.
* Convert Promise APIs at adapter seams.
* Model recoverable failures with tagged errors.
* Use managed resources for connections, subscriptions, streams, workers, and external requests.
* Use `Deferred` for shared async readiness and single-flight initialization instead of storing raw promises with `.then/.catch` bookkeeping.
* Use `Effect.forEach`, `Effect.all`, `Schedule`, `Stream`, `Sink`, `Fiber`, `Semaphore`, and interruption where concurrency, retry, backpressure, cancellation, or observability matter.
* Add telemetry at durable seams and major state transitions.
* Use plain TypeScript for pure local transforms.

# Agent skills

## Domain docs

Domain docs use a single-context layout with root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
