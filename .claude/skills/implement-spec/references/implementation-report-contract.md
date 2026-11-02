# Implementation report contract

Use this structure and report only observed work:

1. **Identity and result** — `COMPLETE`, `PARTIAL`, or `BLOCKED`; date; spec path and SHA-256; plan path and SHA-256; affected repositories.
2. **Starting state** — branch/HEAD where available and all relevant pre-existing uncommitted changes, clearly separated from this run.
3. **Task execution** — each plan `T-xx` marked completed, skipped, or blocked, with actual files/symbols changed and requirement/criterion IDs.
4. **Behavior delivered** — observable result, boundaries, state/data effects, and preserved behavior.
5. **Deviations** — every difference from the plan, evidence and rationale, or `None`. A deviation may not silently change the spec.
6. **Verification evidence** — exact command or procedure, environment, exit/result, relevant summary, and mapped IDs. Separate passed, failed, blocked, and not-run checks.
7. **Changed-file inventory** — files created, modified, or deleted by this run and their purpose. Exclude pre-existing unrelated changes.
8. **Outstanding work and blockers** — impact, evidence, attempted repair, and required next action, or `None`.
9. **Assessment handoff** — confirm whether artifacts are ready for `/assess-spec`; do not claim acceptance approval.

The report is invalid if fingerprints are missing, worktree ownership is ambiguous, a planned task has no disposition, or evidence is inferred rather than observed.
