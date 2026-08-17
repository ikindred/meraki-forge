# Task protocol and execution state

Obsidian task fields are title, ID, mode, priority, outcome, acceptance criteria with stable IDs, evidence sources, constraints, dependencies, deadline, and notes. Executable AUTO/HOTFIX tasks require an outcome and acceptance criteria. The checkbox remains a human representation; PR readiness does not check it.

Human states: READY, IN_PROGRESS, BLOCKED, DISCUSS, REVIEW, DONE. Automation may transition READY to active/decision states, IN_PROGRESS to BLOCKED/DISCUSS/REVIEW, and never REVIEW to DONE. Human reconciliation may reopen REVIEW/BLOCKED/DISCUSS.

Internal phases: INTAKE, RECONCILING, AUTHORIZED, CLAIMED, PLANNING, IMPLEMENTING, OWNERSHIP_CHECK, INTEGRATING, VALIDATING, REPAIRING, EVIDENCE, RELEASE_GATE, PR_CREATING, DELIVERED, BLOCKED.

State records contain schema version, revision, task/mode/status/phase, timestamps, branch/worktree/base/candidate SHA, risk, agents, dependencies, repair attempt, gate results, evidence, PR identity, blocker, and an append-only transition log. Claims use run ID, owner, lease, and compare-and-swap revision. Repair attempt three may complete; any request for a fourth blocks.
