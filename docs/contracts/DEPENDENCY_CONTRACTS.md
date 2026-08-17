# Dependency and finding contracts

All messages use a versioned immutable envelope: `kind`, `schema_version`, `id`, `task_id`, `run_id`, `from`, `to`, `created_at`, and typed `payload`.

Supported kinds are DEPENDENCY_REQUEST, CONTRACT_CHANGE_REQUEST, SEMANTIC_CONFLICT, BLOCKER_REPORT, SECURITY_FINDING, QA_FINDING, and REVIEW_FINDING. Requests identify requested owner/domain, reason, required output, related acceptance IDs, affected paths, and blocking status. Findings include severity, evidence, required property, affected paths, expected owner, and stable status.

Contracts cannot transfer write authority. A contract change creates a new manifest revision after the proper product/technical authority accepts it. Semantic conflicts block integration until a decision artifact exists. Repairs reference finding IDs.
