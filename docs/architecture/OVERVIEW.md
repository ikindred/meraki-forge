# Architecture overview

Forge is a deterministic policy kernel surrounded by effectful adapters. Agent prompts consume resolved policy; they do not define it.

```text
Obsidian task + repository snapshot + project policy
                         |
                         v
     task parser -> stack evidence -> reconciliation
                         |
                         v
       risk + router + persona/skill composition
                         |
                         v
             immutable execution manifest
                         |
                         v
      coordinator / specialists (Phase 2 effects)
                         |
                         v
 ownership -> validation -> evidence -> release eligibility
                         |
                         v
             GitHub PR -> REVIEW -> STOP
```

## Phase 1 packages

- `packages/kernel`: pure contracts, stack detection, composition, ownership, risk, routing, state, gates, evidence, and PR eligibility.
- `packages/adapters`: filesystem/Obsidian/config adapters behind explicit ports.
- `packages/cli`: thin command boundary; full bootstrap is deliberately deferred.
- `personas` and `skills`: composable data, not permission sources.
- `templates`: future managed project, Obsidian, Codex, and GitHub outputs.
- `tests/fixtures/repos`: small multi-stack evidence repositories.

Director, Coordinator, dispatch, worktree mutation, evidence capture, and GitHub effects are Phase 2–4. Phase 1 defines their inputs and invariants without pretending those effects exist.

## Repository awareness

Detection retains evidence per module rather than selecting one global stack. Repository inspection must eventually record branch, status, remotes, base/candidate SHA, worktrees, relevant history, and offline/fetch freshness. Unknown stacks remain unknown; generic expertise is safer than guessing.
