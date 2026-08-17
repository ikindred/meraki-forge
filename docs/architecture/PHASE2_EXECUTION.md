# Phase 2 execution architecture

Phase 2 is a local-only, resumable execution layer. It adds no GitHub PR, merge, deployment, evidence capture, video, scheduler, or production capability.

## Components

- `kernel/execution`, `lease`, and `dependency-graph`: versioned manifests, least-authority dispatches, exclusive durable leases, explicit stale takeover, deterministic DAG scheduling, and dependency routing.
- `kernel/repair` and `integration`: three-round repair ceiling and a mechanical-only integration allowlist. Semantic work emits `SEMANTIC_CONFLICT`.
- `adapters/safe-state-store`: canonical `.forge/state`, schema validation, containment, atomic fsync/rename, CAS locks, explicit stale-lock recovery, and corruption detection.
- `adapters/git-adapter` and `worktree-manager`: `execFile`-only Git inspection, base reconciliation, one deterministic task branch/worktree, real NUL-safe change collection, rename/delete/gitlink attribution, symlink escape protection, and case-collision detection.
- `adapters/git-change-collector`: clean per-agent baselines. Approved rounds become local acceptance commits; rejected rounds are restored before another persona runs.
- `execution/director`: repository/task reconciliation, stack/risk/routing, manifest construction, lease claim, and worktree creation/reuse. It has no application implementation capability.
- `execution/coordinator`: durable dispatch outbox, real changed-path boundary checks, dependency-node insertion, completed-node deduplication, crash-safe blocking, and cross-invocation resume.

## Attribution decision

One task uses one primary worktree and only one modifying persona runs at a time. Every agent round begins from a clean commit. The coordinator validates all actual changes from that baseline. Accepted output is committed locally as a mechanical attribution boundary. Rejected output is restored to the baseline. This prevents a later specialist from inheriting or being blamed for another agent's dirty changes.

## QA and integration

QA can write only explicitly owned and task-granted non-production paths under `tests`, `e2e`, `.forge/artifacts`, `test-results`, or `playwright-report`. Production source remains denied. Integration Agent remains production-read-only; typed integration policy permits mechanical operations only.

## Stop behavior

Active foreign leases, corrupt state, unsafe paths, unmatched worktree identity, boundary violations without a known owner, stranded dispatches after a crash, semantic conflicts, and exhausted repairs all stop or block deterministically. Ordinary execution never steals an active lease or stale state lock.
