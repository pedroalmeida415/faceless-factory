# Effect-Native Runtime Slice

Accepted. The runtime vertical slice moves fully into Effect so Task orchestration, repository transactions, queue delivery, the Workflow Event Stream, workers, and Post-Commit Work share typed errors, interruption, retry, Layer-based dependencies, and OpenTelemetry observability. Repository Modules should use `@effect/sql-drizzle`, observability should use `@effect/opentelemetry`, Effects should run only at framework and worker Adapters, and unrelated app Modules are intentionally left outside this pass.
