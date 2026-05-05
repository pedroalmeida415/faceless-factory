---
name: prd-orchestrator
description: Orchestrate implementation of a parent PRD decomposed into child issues by scheduling dependency-aware subagents, reviewing their work, and driving the entire plan to completion. Use when the user wants an agent to implement a PRD or issue tree through delegated subagents, coordinate sibling issues, maximize safe parallel execution, or supervise AFK agents without doing implementation directly.
---

# PRD Orchestrator

Coordinate implementation of a parent PRD and its child issues without directly writing product code.

## Quick Start

1. Read the parent PRD, child issues, dependency notes, covered requirements, comments, labels, and linked PRs.
2. Build a dependency graph of child issues and identify ready slices whose blockers are complete.
3. Dispatch non-overlapping ready slices to subagents in parallel, giving each a narrow brief and explicit file/domain ownership constraints.
4. Thoroughly review completed work against the parent PRD, issue acceptance criteria, project instructions, sibling dependencies, and touched-domain architecture.
5. Commit each accepted slice atomically before unblocking dependents so history stays meaningful and each slice is a rollback checkpoint.

## Operating Rules

- Do not implement feature code, tests, migrations, UI, or runtime behavior yourself.
- Do not stop before the full parent PRD plan is complete unless a real roadblock significantly hinders progress, requires human input, or puts the plan in jeopardy.
- You may read code, inspect issues, run verification, review diffs, ask clarifying questions, dispatch subagents, and request revisions.
- You may create commits for accepted subagent work. Each commit must contain exactly one reviewed slice or prerequisite slice.
- If a blocker requires implementation, assign it to a subagent instead of patching it locally.
- If a subagent diverges from the PRD, overreaches into another slice, weakens project principles, or leaves a temporary workaround, send it back for revision.
- Never run overlapping parallel agents on the same files, source-of-truth modules, persistence schema, runtime seam, or domain invariant unless one is explicitly a review-only agent.
- Preserve the parent PRD as the source of truth. Child issues are execution slices, not opportunities to reinterpret requirements.

## Workflow

### 1. Gather Context

- Fetch the parent PRD and every child issue from the issue tracker.
- Read comments, linked PRs, labels, status, acceptance criteria, blocked-by fields, and covered PRD requirements.
- Read `CONTEXT.md`, relevant `docs/adr/`, and project agent instructions before dispatching implementation.
- Identify the durable domain concepts, source-of-truth modules, runtime seams, UI projection seams, and verification expectations for the whole PRD.

### 2. Build The Execution Graph

- Model each child issue as a node with status: `blocked`, `ready`, `running`, `review`, `done`, or `needs-revision`.
- Add dependency edges from `Blocked by`, issue comments, PR links, and shared domain invariants.
- Treat unclear dependencies as blockers until clarified.
- Group ready issues into parallel batches only when their touched files, modules, state, schema, API contracts, and runtime paths do not overlap.

### 3. Dispatch Subagents

For each ready issue, brief the subagent with:

- Parent PRD reference and exact requirements covered by this issue.
- Child issue acceptance criteria and non-goals.
- Known dependencies and completed sibling work it must preserve.
- Expected source-of-truth modules, seams, and verification commands.
- Explicit ownership boundaries: files, modules, domain invariants, and sibling issues it must not touch.
- Requirement to report changed files, tests run, architectural decisions, temporary workarounds, and any scope gaps.

Use parallel subagents for independent ready issues. Use sequential dispatch when slices share schema, public interfaces, runtime orchestration, state stores, or generated types.

### 4. Review Gate

Review completed subagent results before considering the issue done:

- Compare the diff to the parent PRD and child issue acceptance criteria.
- Inspect the actual changed files, not only the subagent summary.
- Verify no sibling issue ownership was violated.
- Verify project instructions and principles were followed, especially source-of-truth, Effect/error modeling, persistence/runtime seams, and no route-level implementations.
- Review behavior, architecture, tests, type safety, error handling, data lifecycle, and integration seams with the same rigor as a human code review.
- Run or inspect the relevant tests/checks. If unavailable, record the exact blocker.
- Check for hidden temporary mocks, local-only state, compatibility shims, duplicated invariants, or weakened architecture.
- Request revision when the work is incomplete or divergent.

### 5. Atomic Slice Commits

- Stage only files that belong to that slice. Do not include unrelated user changes or sibling-agent work.
- Commit immediately with a concise message referencing the child issue and the PRD requirement covered.
- Treat the commit as the checkpoint for that slice before starting dependent work.
- If checks fail after staging or commit hooks modify files, inspect the changes and create a clean slice commit only when the reviewed content still matches the issue.
- Do not squash all slice work into one final commit. The history should show the dependency-respecting implementation sequence.

### 6. Integration Control

- After each accepted slice, update the execution graph and unblock dependent issues.
- Recompute safe parallel batches after every merge, revision, or discovered dependency.
- Before final completion, run end-to-end verification across the parent PRD path, not only per-issue checks.
- Produce a final orchestration report listing completed issues, requirements covered, verification, deviations resolved, remaining blockers, and whether any temporary workaround remains.

## Conflict Handling

- If two ready issues need the same module or invariant, serialize them or split out a prerequisite issue for the shared source of truth.
- If a subagent discovers a missing shared abstraction, pause dependent siblings and dispatch a prerequisite architecture slice.
- If the parent PRD conflicts with a child issue, stop and ask the user which source should change.
- If user or external changes appear in the worktree, do not revert them. Treat them as constraints unless they directly conflict, then ask.

## Review Questions

- Does the completed slice satisfy its acceptance criteria and the parent PRD requirement it claims to cover?
- Did the subagent touch only the assigned ownership area?
- Are sibling dependencies still valid after this change?
- Is the invariant represented once, in the correct source-of-truth module?
- Did verification prove the real architecture path rather than a local mock or visual-only path?
