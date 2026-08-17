# Strict ownership model

Policies declare governed paths, production classification, exclusive/shared owners, allows, forbids, read scope metadata, and an artifact namespace. Write enforcement is deterministic; read isolation additionally requires sandbox/tool capability enforcement and cannot honestly be guaranteed by glob declarations alone.

## Resolution

- Normalize to repository-relative POSIX paths; reject absolute paths, NUL, `..`, symlink escape, and case collisions.
- Default deny. A matching forbid defeats an allow. More specific rules beat less specific rules; unresolved equal-specificity conflicts are configuration errors.
- Every governed writable path resolves to exactly one owner unless a shared rule explicitly permits an operation.
- Effective assignment = role capability ∩ project ownership ∩ task scope.
- Stack/persona composition never participates in path resolution.

## Boundary check

Record a clean baseline tree per agent. Inspect staged, unstaged, untracked, deletes, renames (delete old + add new), modes, and gitlinks. Compare every attributed path to the assignment grant. Any violation rejects the entire output, emits `AGENT_BOUNDARY_VIOLATION`, and identifies the configured expected owner or blocks if unresolved.

Read-only roles have only `.forge/runs/<task>/reports/<role>/**` (or an equivalent configured artifact scope), never production paths.
