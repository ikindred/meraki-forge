# Forge v1 reference analysis

Status: accepted input to the v2 architecture  
Reference: `/Users/kindredinocencio/Documents/Meraki Forge old` (read-only inspection on 2026-08-11)

## Scope and conclusion

The reference workspace is an AI-assisted delivery workspace, not yet a reusable autonomous operating system. Its strongest ideas are human authority, mission-first project setup, visible handoffs, Obsidian memory, and independent review roles. Its critical controls remain duplicated prompt text: there is no deterministic task router, ownership engine, durable coordinator, evidence gate, scheduler, worktree attribution, or PR delivery pipeline.

No reference file is copied into v2. Each concept below was evaluated against the new authority model.

## KEEP

- **Human delivery authority.** `AGENTS.md` and `.codex/AGENTS.md` reserve production release for the owner. V2 narrows the automated boundary further: Forge has no merge or production-deploy capability.
- **Mission-first lifecycle.** `projects/<name>/{mission,planning,code,qa,memory}` is a useful separation of intent, planning, implementation, validation, and durable knowledge.
- **Small responsible team and one owner per scope.** The old governance explicitly discourages overlapping agents. V2 makes this mechanically testable.
- **Clear department roles.** Coordinator, product, architecture, design, implementation, QA, review, release, and reporting roles are good conceptual seeds.
- **Structured run visibility.** `mission-control/schemas/run.schema.json` covers mission, safety, phases, agents, handoffs, changed files, blockers, approvals, and reports.
- **Validated project slug and starter creation.** `scripts/create-project.sh` demonstrates useful guardrails for generated project structure.

## IMPROVE

- Validate every runtime record against strict, versioned schemas. Old Mission Control renders JSON without validating it, and most statuses are free-form strings.
- Replace a static run snapshot with append-only events plus a versioned materialized state record.
- Consolidate repeated authority, lifecycle, and approval text into a single constitution with generated summaries.
- Convert QA, security, accessibility, review, and evidence expectations into computed gates with PASS/FAIL/NOT_APPLICABLE semantics.
- Add repository branch, base commit, task lease, worktree, and candidate commit identity to durable state.
- Preserve Obsidian as the human control surface while making `.forge/state` the canonical execution state.

## REDESIGN

- **Agent organization:** static TOML prompts become composable role + stack skill + repository context + an independently resolved ownership grant.
- **Mission Control:** the demo JSON reader becomes a consumer of real task state/events; it is not the execution engine.
- **Orchestration:** human/prompt-selected sequences become deterministic routing decisions, structured dependency requests, leases, and resumable state.
- **Repository layout:** the old workspace embeds client projects inside Forge. V2 is reusable infrastructure installed into independently owned target repositories.
- **Memory:** vault notes, generated reports, source truth, and workflow learnings receive explicit precedence and reconciliation rules.
- **Release:** descriptive release preparation becomes a commit-bound eligibility decision and idempotent PR package in later phases.

## REMOVE

- Demo Todo Mission as the default runtime state.
- Pokemon Card Shop and its domain assumptions from the reusable core.
- Absolute personal filesystem paths from managed configuration and templates.
- A generic `senior_developer` with broad write authority; v2 uses strict frontend, backend, mobile, and database owners.
- Automatic production-release approval syntax. V2 stops at PR and exposes no deployment operation.
- Duplicated policy prose across root instructions, Codex instructions, READMEs, company workflows, and vault notes.

## REFERENCE ONLY

- `projects/pokemon-card-shop/` for brownfield lifecycle and QA examples.
- `Meraki_Vault/.obsidian/` for Obsidian configuration behavior, not portable policy.
- `.codex/agents/*.toml` for role vocabulary, not enforcement.
- `mission-control/app/` and schemas for dashboard information needs.
- `.gstack/` logs and tool availability records as local artifacts only.
- Project-specific compatibility pointers such as `CLAUDE.md -> AGENTS.md`.

## Capability gaps and lessons

| Area             | Reference reality                        | V2 response                                                                         |
| ---------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Ownership        | Prompt-only, no changed-path attribution | Default-deny compiler, normalized matcher, clean baseline and violation records     |
| State            | Static demo snapshot                     | Versioned persisted state, revision, lease, transition events                       |
| Scheduling       | Daily folders only                       | Small scheduler triggers over repository-managed contracts (Phase 4)                |
| Worktrees        | No first-class model                     | One task/branch/worktree, serialized writers unless isolation is required (Phase 2) |
| QA/security/a11y | Responsibilities described               | Read-only findings and enforceable gate plans                                       |
| Evidence         | Folders/conventions only                 | Commit-bound evidence manifest with acceptance mapping and digests                  |
| PR               | No automation/template                   | Eligibility-bound, idempotent PR delivery (Phase 4)                                 |
| Video            | Not present                              | Acceptance-driven capture policy (Phase 3)                                          |
| Duplicate work   | Checkbox/prompt judgment                 | Repository reconciliation and task fingerprint                                      |

The principal lesson is that prompts are suitable for judgment and expertise, but unsuitable as the sole enforcement mechanism for safety, ownership, state, or release.
