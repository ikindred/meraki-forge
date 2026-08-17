# Bootstrap architecture (Phase 5 design)

Bootstrap is deliberately not implemented before the kernel is validated. It will inspect a target repository, ask for command center/vault/autonomy/PR/evidence settings, and generate repo-local `AGENTS.md`, `.forge/{config,project,ownership,state}`, `.codex/agents`, `docs/ai`, and the Obsidian command center.

Managed defaults and explicit project overrides are stored separately. Upgrade may replace versioned Forge-managed assets but must preserve overrides and report conflicts. Doctor checks environment/readiness. Validate checks ownership coverage/conflicts, read-only roles, safety floors, evidence/scheduler policy, and the impossibility of auto-merge/production deployment.
