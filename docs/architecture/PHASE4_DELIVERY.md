# Phase 4 Delivery

Phase 4 adds controlled delivery after Phase 3 proof succeeds. The autonomous boundary remains a verified pull request ready for human review.

Remote delivery is default-deny. Project policy must explicitly enable branch push and PR creation, while `auto_merge` and `production_deploy` remain literal `false` safety floors. The Release Agent may package release metadata, push only the task branch, create or update a Forge-owned PR section, synchronize the task to REVIEW, and emit PR_READY. It may not edit production implementation, fix validation failures, merge, deploy, mutate secrets, or mark DONE.

The Git remote adapter verifies repository identity, current task branch, candidate SHA, protected/default branch policy, and remote task-branch divergence before pushing one exact non-force refspec. The GitHub adapter is client-based and exposes only auth inspection, repository identity, existing PR lookup, PR creation, and Forge-owned PR body update.

Obsidian integration binds one Command Center to one repository through canonical project mapping. Attachment references resolve inside allowed vault roots only, reject escapes and symlinks, and record digest metadata. REVIEW sync updates only frontmatter status and a delimited Forge-owned block; human acceptance from REVIEW to DONE remains external.

Delivery state is durable under `.forge/state/delivery`, uses optimistic revisions, persists each side effect before the next step, and resumes partial failures without duplicating pushes, PRs, syncs, or notifications. Scheduler templates are prompt contracts only; they do not grant delivery authority.
