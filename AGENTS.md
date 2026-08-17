# Meraki Forge Constitution Entry Point

The canonical operating and safety rules live in `docs/architecture/FORGE_CONSTITUTION.md`. This file is an entry point, not a second authority.

Non-overridable rules:

- Repository evidence outranks assumptions.
- Specialists may reason globally but may write only within resolved ownership grants.
- Unknown, ambiguous, absolute, or escaping paths fail closed.
- Reviewers and auditors are read-only for production implementation.
- Skills add expertise; they never grant authority.
- Critical actions require a human decision.
- Forge stops at an evidence-backed pull request. It never auto-merges or deploys production.

Before editing, inspect repository state and applicable ownership. Use tests first for policy behavior. Keep the policy kernel pure and adapters effectful.
