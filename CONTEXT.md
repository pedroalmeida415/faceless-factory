# Context

## Workflow

### Workflow execution planning

Workflow execution planning is the pure graph/document step that turns a workflow document, selection, execution target, review state, and known output materialization into caller-specific execution plan views. It is the source of truth for target resolution, executable generator nodes, required graph nodes, review barrier nodes, output counts, output dependencies, and pricing inputs.

Quote, start, task scheduling, validation, and runtime execution should consume workflow execution planning rather than recomputing those facts independently.

Workflow document validation owns structural graph integrity that applies before execution intent is known: duplicate identifiers, missing edge endpoints, invalid edge types, and cycles. Execution-specific validation belongs to workflow execution planning: empty target sets, non-generator targets, missing required handles, empty required source nodes, iterator mismatches, output reorder validity, and review barrier planning.

### Generator output execution

Generator output execution is the workflow execution step that turns a resolved generator input batch into a materialized output. It owns output identity, cache/reuse lookup, provider idempotency, provider dispatch, credit cost settlement, output value normalization, generator node projection, and review regeneration settlement.

Workflow orchestration owns graph traversal, input batch resolution, runtime status publication, review pauses, and artifact persistence timing. Generator output execution starts after workflow execution planning and input coercion have selected concrete generator output batches, and finishes before orchestration publishes or persists the resulting workflow state.
