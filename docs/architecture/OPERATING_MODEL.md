# Operating model

## Lifecycle

1. Daily PM reads Obsidian and persisted state, then reconciles intent with repository reality: MISSING, PARTIAL, IMPLEMENTED_UNVERIFIED, or SATISFIED.
2. Safe executable tasks are authorized according to mode, risk, dependencies, and autonomy ceiling.
3. Forge Director resolves a versioned execution manifest, state claim, branch/worktree, stack profile, ownership grants, roles, gates, and evidence policy.
4. Engineering Coordinator builds a dependency graph, serializes writers in the primary worktree, dispatches specialists, and resumes durable state.
5. Each writer is checked against a clean baseline and its exact grant. Forbidden changes reject the output and generate a dependency request.
6. Integration performs only mechanical combination. Semantic conflicts block and return to Architect/relevant owner.
7. QA, security, accessibility, and review report independently. Findings route to the expected owner.
8. At most three completed validation-to-repair rounds are allowed; a fourth is prohibited and the task becomes BLOCKED.
9. Evidence maps each acceptance criterion to final-commit proof.
10. The release gate verifies all invariants. Release creates an idempotent PR and projects status REVIEW to Obsidian, then stops.

## Modes

AUTO may reach PR; PLAN stops at a plan; DISCUSS waits for a human decision; HOLD is externally blocked; HOTFIX is expedited AUTO with all gates intact; REVIEW is read-only unless explicitly converted.

## Worktrees and attribution

The default is one task, one branch, one primary worktree. Write-enabled specialists run serially against recorded baselines. Additional worktrees are allowed only when genuine isolation is required. Concurrent writes in one worktree are prohibited even when intended paths differ because attribution would be unreliable.
