# Plan artifact contract

Use this structure, omitting no section. Replace all guidance with facts; use `Not applicable — <reason>` only when justified.

1. **Identity** — plan status, current date, repository-relative spec path, exact SHA-256, affected repositories, and planning sources.
2. **Readiness check** — evidence that the spec is implementation-ready and internally consistent.
3. **Observed implementation context** — current architecture, relevant files/symbols, applicable instructions, reusable code, test infrastructure, and constraints. Distinguish facts from proposed changes.
4. **Implementation strategy** — execution boundaries, data/control flow, integration approach, compatibility, sequencing rationale, and explicitly rejected alternatives when consequential.
5. **Ordered tasks** — stable `T-xx` IDs. For each: outcome, requirement/criterion IDs, dependencies, affected areas or justified candidate files, concrete changes, invariants, edge cases, and completion evidence. Do not force a filename without repository evidence.
6. **Verification plan** — exact existing commands and manual/tool-assisted procedures mapped to criteria; setup, expected evidence, and limitations. Mark every check as planned, never executed.
7. **Risk and recovery** — regression surface, migrations, compatibility, destructive/external actions requiring separate authority, and rollback or safe recovery where relevant.
8. **Coverage matrix** — every mandatory `RF-*`, `RNF-*`, `D-*`, and `CA-*` mapped to one or more tasks and checks. No mandatory ID may be unmapped.
9. **Implementation handoff** — prerequisites, permitted scope, known non-blocking risks, and explicit confirmation that no blocking ambiguity remains.

An implementation-ready plan contains no unresolved placeholder, speculative contract, invented command, or claim of completed work.
