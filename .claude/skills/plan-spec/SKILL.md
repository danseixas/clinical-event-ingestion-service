---
name: plan-spec
description: Create a fingerprinted, implementation-ready plan from a complete project spec under `.ai/.specs/`. Does not implement the feature or repair incomplete specs.
argument-hint: <spec path or unique basename under .ai/.specs/>
disable-model-invocation: true
context: fork
agent: spec-planner
---

# Plan Spec

Spec requested: `$ARGUMENTS`

This skill runs in the `spec-planner` subagent. If it is running anywhere else, stop with `BLOCKED`; never substitute another agent or model.

## Inputs and authority

Require an explicit spec path or a unique basename that resolves under `.ai/.specs/`. If the request above is empty or ambiguous, stop with `BLOCKED`; never select a spec by recency. Read the selected spec, every referenced source, applicable `AGENTS.md` and `CLAUDE.md`, relevant `.ai/docs/`, manifests, affected code, tests, schemas, and configuration before planning.

The spec is the product and acceptance source of truth. Stop and identify exact gaps if it is incomplete, contradictory, not ready for implementation, or contains a blocking question. Direct the user back to `/create-spec`; do not interview, edit the spec, invent decisions, or emit a partial plan.

## Output contract

Read `.claude/skills/plan-spec/references/plan-contract.md` before writing. Save the plan as `.ai/.plans/<spec-basename>.md`. If that file exists, overwrite it without archiving; Git history is the recovery mechanism.

Compute the SHA-256 digest from the exact bytes of the source spec (`shasum -a 256 <spec>`) and record it with the normalized repository-relative spec path. The plan must be implementation-ready and trace every task and verification activity to applicable `RF-*`, `RNF-*`, `D-*`, and `CA-*` identifiers.

Plan from observed repository evidence. Resolve low-risk, reversible technical details when the codebase establishes a clear choice and record the rationale. Stop rather than silently deciding anything that changes product scope, externally visible behavior, data handling, permissions, integrations, or acceptance meaning.

Do not modify product code, create commits, or claim that planned checks ran. Finish by rereading the spec and plan for complete coverage, feasible ordering, explicit dependencies, and contradictions, then report the saved path and any non-blocking risks.
