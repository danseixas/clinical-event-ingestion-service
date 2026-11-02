---
name: assess-spec
description: Independently validate an implemented project spec against every acceptance criterion and write an evidence report. Does not repair implementation failures.
argument-hint: <spec path or unique basename under .ai/.specs/>
disable-model-invocation: true
context: fork
agent: spec-assessor
---

# Assess Spec

Spec requested: `$ARGUMENTS`

This skill runs in the `spec-assessor` subagent. If it is running anywhere else, stop with `BLOCKED`; never substitute another agent or model.

## Required handoff

Require an explicit spec path or unique basename under `.ai/.specs/`. If the request above is empty or ambiguous, stop with `BLOCKED`; never select by recency. Require the matching plan at `.ai/.plans/<spec-basename>.md` and implementation report at `.ai/.implementations/<spec-basename>.md`.

Recompute SHA-256 from the exact spec and plan bytes (`shasum -a 256 <file>`). Require the plan's spec fingerprint and the implementation report's spec and plan fingerprints to match current artifacts exactly. Stop with `BLOCKED` on any absent, malformed, or stale handoff.

Read the artifacts, applicable `AGENTS.md` and `CLAUDE.md`, relevant code, tests, manifests, and actual working tree. Treat reports as claims to verify, not evidence by themselves. Preserve independence: assess the delivered result against the spec, not the implementer's intent.

## Evidence rules

Evaluate every `CA-*` and every mandatory `RF-*`, `RNF-*`, and `D-*`. Execute the required automated, manual, browser, visual, accessibility, production, or external-service check when its tool, environment, and authorization are available. Otherwise mark that item `BLOCKED`; never replace required direct evidence with builds, code inspection, report text, or inference.

Use criterion results `PASS`, `FAIL`, or `BLOCKED`. Overall result is:

- `PASS` only when every criterion has sufficient passing evidence and all mandatory requirements are covered;
- `FAIL` when at least one criterion has direct failing evidence;
- `BLOCKED` when no criterion fails but at least one lacks required evidence.

Do not modify product code, tests, fixtures, dependencies, or configuration to obtain a pass. Do not create commits. Writing the assessment report and, after a full pass, updating spec metadata are the only permitted mutations.

## Report and status

Read `.claude/skills/assess-spec/references/assessment-contract.md`. Write `.ai/.assessments/<spec-basename>.md`, overwriting any existing report without archiving. Record exact evidence, not conclusions alone.

Only after the report establishes overall `PASS`, update the source spec to status `implemented and verified`, use today's date, and link the assessment report. Because that edit changes the spec fingerprint, record both the assessed pre-status-update fingerprint and the final post-update fingerprint in the assessment report. Do not alter spec requirements or status on `FAIL` or `BLOCKED`.

End with the overall result, report path, pass/fail/blocked counts, and precise next action. Route remediation to `/implement-spec`; do not fix findings.
