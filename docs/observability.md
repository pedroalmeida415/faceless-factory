# Observability

## End-to-End Trace Propagation

Faceless Factory should support traces that survive frontend, backend, queue, worker, provider, pub/sub, and callback boundaries.

Use `Effect.fn("feature.component.action")` for durable use-case, adapter, provider, queue, and worker spans where function-level stack traces and span names improve debugging. Keep deterministic domain functions plain TypeScript unless they cross an I/O, lifecycle, concurrency, telemetry, or recoverable-failure seam.

Trace context must be propagated explicitly across serialized or process boundaries. Effect fiber-local span context does not survive HTTP headers, Redis/BullMQ jobs, pub/sub messages, webhooks, process restarts, or worker handoff.

Use W3C trace context as operational metadata:

- `traceparent`
- optional `tracestate`
- optional `baggage` only when explicitly sanitized and justified

Required propagation points:

- Frontend injects trace context into tRPC/HTTP requests when browser tracing is enabled.
- Backend HTTP/tRPC adapters extract incoming trace context before running Effect programs.
- Use-cases create named spans such as `workflow.useCase.saveWorkflow` or `billing.useCase.getBillingOverview`.
- Queue/pub-sub enqueue adapters capture the current propagated span context and serialize it into job or message metadata.
- Worker/subscriber adapters extract serialized trace context before opening processing spans.
- Provider and storage adapters create spans under the active worker/use-case context.
- Webhooks and provider callbacks extract inbound trace context when providers support it; otherwise they start a root span and annotate that remote context was missing.

Missing or invalid trace context must not fail domain work. Start a root span and record sanitized telemetry instead.

Prefer parent-child spans for direct causal work. Use span links instead of parent-child relationships for fan-out, retries, replay, wake-up calls, or work items derived from multiple possible parents.

Do not attach raw prompts, media payloads, credentials, secrets, unredacted PII, or large payloads to spans, logs, metrics, trace baggage, queue metadata, or pub/sub metadata. Use stable IDs and sanitized operational metadata such as `workflow_id`, `node_id`, `task_id`, `job_id`, `provider`, `model`, `status`, and `attempt`.
