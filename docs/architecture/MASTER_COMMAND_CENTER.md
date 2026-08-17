# Master Command Center

## First-time machine initialization

Run `forge init` once after installing the CLI. It creates the versioned master configuration and project registry under `~/.meraki-forge`, plus the configured projects root and shared Obsidian vault. `forge init --dry-run` reports the complete plan without filesystem mutations. Re-running init preserves registered projects and human vault content.

After initialization, `forge doctor` reports machine readiness. `forge project create --name "Name"` uses the configured projects root and shared vault automatically.

Meraki Forge maintains one global, versioned project registry above the existing per-repository execution engine. Every write request must resolve exactly one registered project before it can enter Director/Coordinator. Cross-project reads are allowed; cross-project writes are rejected.

Each registered project retains its own Git repository, `.forge` governance and durable state, and project-local `graphify-out/` index. Graphify is an orientation aid only: Forge binds its metadata to a full Git commit and verifies all conclusions against the live repository.

The shared Obsidian vault is the human control and memory layer:

```text
Dashboard.md
Projects/<Project>/Project.md
Projects/<Project>/Tasks.md
Projects/<Project>/{Decisions,Notes,Reports}/
Cross Project/
Boss Reports/
```

Legacy `<Project>/AI Engineering` workspaces remain valid and are never moved or deleted automatically. Onboarding creates or links the new project workspace without reinterpreting Obsidian as execution authority.

## Natural-language routing

When a request names a project, resolve it through `forge project inspect <reference>` before reading or writing. Use `forge project list` for registry questions, `forge project graph <reference> status` before graph-assisted code queries, and `forge ownership review <reference>` when ownership approval remains pending. Never guess an ambiguous reference.

The autonomous boundary remains verified PR, human review, stop. The master layer cannot merge, deploy, or expand project ownership.
