---
name: implement-spec
description: Implement a project spec from its matching fingerprinted plan and produce an evidence-based implementation report. Does not plan missing work or perform final acceptance assessment.
argument-hint: <spec path or unique basename under .ai/.specs/>
disable-model-invocation: true
context: fork
agent: spec-implementer
---

# Implement Spec

Spec requested: `$ARGUMENTS`

This skill runs in the `spec-implementer` subagent, pinned to the cost-efficient Sonnet model at medium effort. If it is running anywhere else, stop with `BLOCKED`; never substitute or escalate to another model.

## Resolve and validate inputs

Require an explicit spec path or a unique basename under `.ai/.specs/`. If the request above is empty or ambiguous, stop with `BLOCKED`; never select by recency. Require `.ai/.plans/<spec-basename>.md`. Recompute SHA-256 from the exact spec bytes (`shasum -a 256 <spec>`) and require an exact match with the plan. Stop and require `/plan-spec` when the plan is absent, malformed, or stale.

Read the full spec, plan, their sources, applicable `AGENTS.md` and `CLAUDE.md`, relevant `.ai/docs/`, and affected code before editing. Treat the spec as product truth and the plan as execution guidance; stop on contradictions rather than choosing silently.

## Working-tree gate

Inventory Git state in every affected repository before editing. Continue with existing changes only when they do not overlap planned files or behavior. Record the pre-existing state, preserve unrelated work, and stop when ownership or overlap cannot be determined safely. Never discard, overwrite, stage, or commit user changes.

## Execute

Complete the full plan in one run. Keep changes within authorized scope and follow applicable repository instructions. You cannot ask the user for authority mid-run: when a destructive action, external side effect, secret, missing contract, or material scope decision is required, stop that line of work and record it as a blocker. Do not broaden scope to make checks pass.

Run proportional checks during implementation, including focused tests and relevant build, lint, type, integration, visual, or accessibility checks that are available and justified (see the `scripts` in `package.json`). A failed check permits one focused repair attempt within the same scope; if it still fails, stop that line of work, preserve safe progress, and report the blocker. Passing implementation checks is not final acceptance approval.

## Report

Read `.claude/skills/implement-spec/references/implementation-report-contract.md`. Write `.ai/.implementations/<spec-basename>.md`, overwriting any existing report without archiving. The report must contain the current spec and plan fingerprints, actual changes, deviations, checks, remaining failures, and pre-existing worktree state. Never claim unexecuted evidence.

Do not update the plan, source spec status, or create commits. End with the implementation outcome, report path, checks run, and any blocker. Direct final acceptance validation to `/assess-spec`.
