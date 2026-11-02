# [Feature name] — [observable outcome]

> How to use: copy this into its own spec and replace the placeholders. Remove the guidance after filling it in. Adjust the depth to the risk and complexity; mark inapplicable sections “Not applicable” and give a reason. Do not invent requirements just to fill out the template.
>
> A complete spec makes it possible to implement and verify the deliverable without guessing about behavior. Distinguish observed facts, adopted decisions, and open questions. Writing a spec does not automatically authorize implementation, publication, or external integration.

## 1. Status and reading contract

- Status: [draft / under review / ready for implementation / implemented and verified].
- Updated: [YYYY-MM-DD].
- Decision owner: [person/team, if known; do not invent].
- Affected areas/routes: [surfaces and paths].
- Audience: [who uses it and in what situation].
- Deliverable type: [prototype / demo frontend / integrated feature / other].
- Related or superseded document: [reference, if any].
- Convention: `RF-xx` for functional requirements; `RNF-xx` for quality requirements; `D-xx` for decisions; `CA-xx` for acceptance criteria.

[State whether this describes the desired state or a deliverable that has already been verified. Requirements are mandatory unless explicitly marked optional.]

## 2. Context and problem

[Explain the current situation, the person's specific difficulty, and why the change is needed. Include only context that helps determine behavior, scope, or architecture.]

### Evidence and current state

| Verifiable reference | Observed fact | Implication |
| --- | --- | --- |
| [file, route, design, issue, or document] | [what actually exists] | [what to reuse, fix, or preserve] |

[Describe what works, what is missing, and how the desired state differs from the current one. Check the manifest and code: do not describe a desired library as already installed.]

## 3. Objective and expected outcome

[Describe what the person will be able to do in observable terms. Distinguish local validation, simulation, and real operation when relevant.]

- Product outcome: [delivered capability].
- Verifiable success signal: [behavior/measure and how to observe it].
- Limits of the claim: [what the outcome does not prove, if applicable].

[Do not invent numerical targets or promise capabilities that depend on items outside the scope.]

## 4. Scope

### Included

- [Specific capability and its limits.]
- [States, surfaces, and integrations actually being delivered.]

### Out of scope

- [Related functionality that might be inferred but will not be implemented.]
- [Infrastructure, channel, or workflow deferred to another deliverable.]

### Preserve

- [Existing behavior, identity, compatibility, or data the change must preserve.]

## 5. Decisions, assumptions, and questions

### Adopted decisions

| ID | Concrete decision | Rationale and impact |
| --- | --- | --- |
| D-01 | [chosen behavior] | [reason and relevant consequence] |

### Assumptions to verify

| Assumption | Available evidence | Confirmation / effect if false |
| --- | --- | --- |
| [hypothesis, not presented as fact] | [source or “unconfirmed”] | [verification and possible revision] |

### Open questions

| Question | What does it block? | Owner, if known | Next step |
| --- | --- | --- | --- |
| [missing decision] | [dependent part or “non-blocking”] | [person/team or “to be determined”] | [how to resolve; alternative only if authorized] |

[Resolve reversible choices using the available context and record them. Highlight decisions that change scope, data, integrations, or the product promise. Do not hide a blocking decision in a later section’s placeholder.]

## 6. User journey and states

### Preconditions and entry

- [How the person gets there, required permissions, existing data, and initial state.]

### Main flow

1. [Person's action.]
2. [System's observable response.]
3. [Completion and final state.]

### Alternatives and exceptions

- [Applicable cases such as invalid input, cancellation, retry, missing data, denied permission, and actual failures.]

| State | Trigger | UI and permitted actions | Exit condition |
| --- | --- | --- | --- |
| [initial] | [opening] | [content and controls] | [action] |
| [processing, if applicable] | [operation] | [feedback, duplicate prevention, and cancellation] | [completion/failure] |
| [error, if applicable] | [failure] | [message, preserved data, and recovery] | [correction/retry] |
| [success] | [valid completion] | [feedback, clearing/preservation, and navigation] | [next interaction] |

[Define resubmission, editing after success, reload, returning to the screen, and interruption where applicable. Do not create artificial states without an operation to justify them.]

## 7. Functional requirements and contracts

### RF-01 — [Capability]

- Trigger: [action/condition].
- Rules: [deterministic behavior and precedence].
- Output: [feedback, state, navigation, or effect].
- Exceptions: [what happens when conditions are not met].
- Side effects: [permitted data, events, persistence, and calls].

[Repeat for each capability. Avoid vague statements such as “validate correctly,” “modern layout,” or “handle errors” without verifiable behavior.]

### Data and validation, when applicable

| Field | Type, label, and initial value | Normalization | Rules and limits | Exact message |
| --- | --- | --- | --- | --- |
| [name] | [input contract] | [trim, case, or none] | [required status, format, and evidence-based limits] | [copy] |

- Validation timing: [submit/blur/change and revalidation].
- Precedence and focus: [which error takes precedence and how to reach it].
- Preservation/clearing: [error, success, cancellation, and reload].
- Boundaries: [empty values, whitespace, Unicode, long values, and relevant extreme formats].
- Source of truth: [schema/contract; avoid duplicated rules].

### Integrations, when applicable

| Operation | Confirmed contract | Success | Failures and recovery |
| --- | --- | --- | --- |
| [operation] | [documented method, endpoint, authentication, and payload] | [response used by the UI] | [codes, timeout, retry, and duplicate handling] |

[Do not invent endpoints or responses. If it is mocked, identify it as a mock and define deterministic results, limits, and how to distinguish it from a real integration.]

### Content and actions

| Element | Text/accessibility name | Action and destination | States |
| --- | --- | --- | --- |
| [button/link/feedback] | [exact copy when relevant] | [actual effect and confirmed route] | [enabled, disabled, busy] |

[Every control needs a defined effect or destination. Finalize critical copy for errors and success, especially when it distinguishes simulation from real operation.]

## 8. Non-functional requirements

### RNF-01 — Visual design, responsiveness, and themes

- Visual reference: [file, image, or existing screen and what to preserve].
- Layout: [hierarchy, alignment, maximum width, spacing, and columns].
- QA breakpoints/viewports: [values and changes at each range].
- Long content/short screens/virtual keyboard: [reflow, scrolling, and limits].
- Themes: [preference source, persistence if any, and state coverage].
- Visual states: [applicable hover, focus, disabled, error, empty, and success states].

### RNF-02 — Accessibility

- Language, landmarks, headings, and semantics: [contract].
- Keyboard and focus: [order, shortcuts, focus after actions/errors, and restoration].
- Screen reader: [labels, descriptions, announcements, and state changes].
- Contrast and targets: [measurable criteria and verification method].
- Zoom, reflow, and reduced motion: [behaviors and QA scenarios].

### RNF-03 — Privacy and security

- Sensitive/personal data: [what exists and where it may flow].
- Persistence: [what to store, duration, and clearing; or explicit prohibition].
- Logs: [event, level, permitted payload, environment, and prohibited values].
- Permissions and trust boundaries: [server/client, when applicable].

[Client-side validation does not replace server-side authorization. Do not log credentials or sensitive payloads to facilitate QA.]

### RNF-04 — Quality, performance, and compatibility

- Supported environments/browsers: [matrix and limitations].
- Performance: [operation, evidence-based budget, and measurement; or not applicable].
- Reliability: [applicable duplicate handling, concurrency, hydration, and recovery].
- Dependencies: [reuse, compatibility, and installation constraints].

## 9. Technical guidelines and impact

- Applicable instructions: [AGENTS.md and relevant local guides].
- Observed stack: [versions verified in the files].
- New dependencies: [need and compatibility to verify].
- Architecture: [execution boundaries and responsibilities].
- Reuse: [existing components, schemas, and tokens].
- Constraints: [what not to add/rewrite and why].

| File/area | Current state | Expected change | Risk/regression |
| --- | --- | --- | --- |
| [actual path or suggested area] | [evidence] | [responsibility] | [effect on other parts] |

[Distinguish required contracts from organizational suggestions. Do not require new files if existing ones can be reused. In Next.js, consult the local guides for the installed version before proposing APIs.]

## 10. Traceable acceptance criteria

| ID | Given / when | Then, observable | Requirement |
| --- | --- | --- | --- |
| CA-01 | [precondition and action] | [verifiable outcome] | [RF/RNF/D] |
| CA-02 | [negative/boundary scenario] | [error, focus, preservation, and absence of unintended effects] | [RF/RNF] |
| CA-03 | [accessibility/theme/layout] | [objective criterion] | [RNF] |

[Cover the happy path, invalid input, recovery, repetition, side effects, and critical constraints. Every mandatory requirement needs a criterion; every criterion must be grounded in scope. Criteria are not a list of files to create.]

## 11. QA and evidence

| Area/criteria | Setup and procedure | Expected result | Evidence |
| --- | --- | --- | --- |
| [critical behavior] | [fictional data and reproducible steps] | [result/CA] | [test, capture, or observation] |
| [technical quality] | [existing, appropriate command] | [pass condition] | [output/summary] |
| [visual/accessibility] | [viewport, theme, keyboard/screen reader] | [result/CA] | [capture, tool, and measurement] |

- Automation: [important rules and behaviors; use existing infrastructure where possible].
- Manual QA: [what requires visual inspection, a device, or assistive technology].
- Regressions: [affected flows and proportional verification].
- Record: [environment/version and approved/failed/blocked/not run status, with reason].

[Check scripts before listing commands. Do not present a planned test as executed, a build as proof of accessibility, or an unavailable tool as approval. Avoid tests that mirror the implementation and new frameworks without need.]

## 12. Definition of done and delivery

- [ ] No blocking decisions or required placeholders remain.
- [ ] Scope implemented and criteria verified with actual results.
- [ ] States and negative scenarios covered.
- [ ] Responsiveness, themes, and accessibility verified as applicable.
- [ ] Data, logs, persistence, and integrations comply with the contracts.
- [ ] Technical checks executed and limitations declared.
- [ ] Changes limited to scope; dependencies/lockfile consistent.
- [ ] Delivery describes final behavior, relevant files, tests, and outstanding work.

Expected artifact: [code, document, captures, report, or other].
External actions/publication: [only those explicitly authorized; or not applicable].

## 13. References and consistency review

- [Sources actually consulted and each source’s purpose.]
- [Related specs and confirmed contracts.]

Before marking as ready, check:

- Is the promised outcome achievable with the included scope and integrations?
- Does every control have defined behavior, destination, and state?
- Do the rules specify when to validate, which message to show, and what to preserve?
- Do success, failure, and retry have clear outcomes?
- Are product decisions distinguished from observed facts?
- Do the criteria allow the deliverable to be evaluated without relying on the implementer’s intent?
- Are there contradictory requirements, arbitrary numbers, or details that do not help with implementation or verification?
