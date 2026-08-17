# Meraki Forge

Meraki Forge is a reusable autonomous engineering operating system. It turns repository-aware tasks into independently validated, evidence-backed pull requests while enforcing strict specialist ownership. The pull request is the autonomous delivery boundary: Forge never merges or deploys production.

This repository is a clean implementation. The previous experimental workspace is reference material only.

## Current scope

Phases 1-4 are implemented locally: deterministic foundation, resumable execution, independent validation/evidence, and controlled delivery to a verified PR ready for human review. Remote mutation remains default-deny and must be explicitly configured; Forge still has no merge or production deploy capability. Bootstrap/doctor/upgrade work remains Phase 5.

See [architecture](docs/architecture/OVERVIEW.md), [constitution](docs/architecture/FORGE_CONSTITUTION.md), and [roadmap](docs/architecture/IMPLEMENTATION_ROADMAP.md).
