# Assessment report contract

Use this structure without omitting failed, blocked, or not-applicable evidence:

1. **Identity and overall result** — `PASS`, `FAIL`, or `BLOCKED`; date; environment; spec, plan, and implementation-report paths; assessed fingerprints; affected repositories and revision/worktree state.
2. **Handoff integrity** — fingerprint checks, artifact completeness, implementation-report claims checked against the working tree, and any mismatch.
3. **Acceptance matrix** — one row per `CA-*`: result, exact setup/action, expected outcome, observed outcome, direct evidence, and linked requirements.
4. **Mandatory-requirement coverage** — every `RF-*`, `RNF-*`, and `D-*` mapped to assessed criteria/evidence; flag any uncovered requirement as `BLOCKED`.
5. **Technical checks** — exact commands/procedures, environment, exit/result, relevant output summary, and which criteria they support. A successful build is evidence only for what it directly proves.
6. **Manual and tool-assisted checks** — viewport/device, theme, browser, keyboard/screen-reader or external-service context, actions, observations, and captures/records where applicable.
7. **Findings** — severity, failed/blocked IDs, reproducible evidence, impact, and required remediation. Do not propose scope beyond the spec.
8. **Regression and side-effect review** — preserved behavior, unintended changes, data/log/security effects, and evidence.
9. **Verdict rationale** — counts and deterministic application of the overall-result rule.
10. **Spec status update** — on `PASS`, the assessed fingerprint, metadata-only changes made, and final post-update fingerprint; otherwise `Not performed`.

Do not mark a criterion passed from implementation-report prose, source inspection alone when behavior is required, an unexecuted command, or a different criterion's evidence.
