---
name: create-spec
description: Create a new implementation-ready project specification from `.ai/.specs/_template.md`. Use when the user invokes /create-spec or asks to define a feature spec, resolve its product and technical decisions interactively, and save the completed spec under `.ai/.specs/`.
argument-hint: <feature or change to specify>
---

# Create Spec

Feature requested: `$ARGUMENTS`

Create a specification only after research and a one-question-at-a-time decision interview have eliminated every material ambiguity, subjective term, unsupported assumption, and behavioral gap.

## Source of truth

Read `.ai/.specs/_template.md` in full at the start of every run. Use its current structure and guidance; do not rely on a remembered copy. If the template is missing, stop and tell the user; do not invent one. Also inspect, as relevant:

- existing specs in `.ai/.specs/`;
- `.ai/docs/`, `PLAN.md`, and every applicable `AGENTS.md` and `CLAUDE.md`;
- the affected code, routes, modules, manifests, schemas, tests, and configuration;
- referenced issues or documents that are locally available.

Research before interviewing. Do not ask the user for facts that the repository or supplied materials can answer. Clearly distinguish observed facts from user decisions.

## Scenario coverage

Make evidence traceable per scenario rather than treating QA as one generic final check. The QA plan and acceptance criteria must cover every applicable observable scenario and state, not only the happy path. For this service that typically includes: accepted/success, validation rejection, malformed or oversized payloads, authentication and authorization failures, duplicates and idempotency, ordering and concurrency, dependency failure (for example Mongo unavailable or a replica-set failover), retry and recovery, and observable side effects such as persisted records, emitted events, logs, and metrics.

For each applicable scenario, require scenario-specific automated or manual evidence (unit or e2e test output, request/response captures, database state checks, log or telemetry records) or an explicit not-applicable reason. Do not mark a spec ready for implementation if its planned QA samples only the happy path or cannot show which evidence proves each scenario. Never claim these checks ran while writing the spec; state them as planned.

If a spec creates or changes a user-facing frontend, ask the user which frontend design and review standards apply and cite them in the spec; do not assume a design system.

## Build a decision ledger

From the research and initial request, privately map every template section to one of:

- confirmed evidence;
- not applicable, with a concrete reason;
- a decision the user must make;
- a missing fact that must be obtained.

Include downstream and boundary decisions, not just the happy path: scope, preserved behavior, audience and permissions, entry and completion states, validation and exact critical messages, failures and recovery, persistence, integrations, privacy/security (clinical data is sensitive), compatibility, acceptance evidence, delivery, and filename. Convert vague words such as "fast," "robust," "properly," and "handle errors" into observable choices.

Resolve low-risk reversible implementation details from repository evidence and record the rationale. Never silently choose anything that changes scope, data handling, integrations, permissions, product promises, irreversible behavior, or externally visible behavior.

## Interview protocol

Ask only after the initial research is complete. Ask exactly one question per turn and wait for the answer before asking the next. Never display the remaining questions as a batch.

Every question must:

1. explain the concrete decision and why it matters;
2. provide mutually exclusive alternatives grounded in the available evidence;
3. mark exactly one alternative as suggested and briefly explain why;
4. leave room for the user to give their own answer;
5. avoid an open-ended prompt when bounded alternatives are possible.

Ask with the `AskUserQuestion` tool, one question per call. Put the suggested alternative first with "(Recommended)" appended to its label, and put the reasoning in each option's description. The tool adds an "Other" choice automatically, so do not add one yourself. Because the user may see only the question dialog, make each question self-contained: state the relevant finding in the question text.

After each answer, update the decision ledger, check for newly exposed dependencies or contradictions, and ask the next highest-impact unresolved question. If an answer is ambiguous, internally inconsistent, or merely subjective, ask a focused follow-up in the same format. Do not reinterpret it silently.

The suggested choice must be a real recommendation based on product goals, existing patterns, risk, and implementation constraints, not an arbitrary default. State uncertainty when evidence is weak.

## Completion gate

Do not create or modify a spec while any material decision or required fact remains unresolved. Before writing, verify that:

- every applicable template placeholder can be replaced with evidence or an explicit decision;
- every inapplicable section has a reason;
- scope, flows, states, edge cases, validation, side effects, integrations, and quality requirements are deterministic and testable;
- exact wording is decided where wording affects behavior, trust, or acceptance (for example error codes and messages returned to clients);
- each mandatory requirement can be traced to acceptance criteria and QA evidence;
- every applicable scenario maps to planned evidence;
- no open question blocks implementation or verification;
- no requirement contradicts another or the observed system.

If a necessary fact cannot be known yet, keep interviewing for an explicit resolution such as deferring the dependent scope, defining a mock, or naming the authoritative contract. Do not write a supposedly complete spec with unresolved blocking questions.

## Write the spec

Once the completion gate passes:

1. Copy the current template structure into `.ai/.specs/<descriptive-kebab-case-name>.md`. Never overwrite `_template.md`.
2. Replace every placeholder and remove all instructional guidance intended only for template authors.
3. Preserve the numbered sections, identifiers, traceability conventions, and useful tables. Adjust depth to actual risk and complexity.
4. Use "Not applicable" only with a specific reason. Do not invent requirements, evidence, endpoints, installed dependencies, commands, measurements, or test results.
5. Record sources consulted and separate observed facts, adopted decisions, and assumptions. A complete interview should leave no blocking open questions; retain only genuinely non-blocking follow-up items when they do not create an implementation or verification gap.
6. Use today's date for `Updated`. Set status according to reality; use `ready for implementation` only when the document meets that contract.
7. Write acceptance criteria as observable Given/When/Then outcomes and ensure every mandatory RF/RNF/decision is covered.
8. List planned QA as planned. Never claim a test, inspection, or verification was performed unless it actually was.

After writing, reread the spec against the template and completion gate. Fix omissions and contradictions before reporting completion. Tell the user the saved path and summarize the principal decisions; do not begin implementation unless separately requested. The next step is `/plan-spec <spec-basename>`.
