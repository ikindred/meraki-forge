# Test strategy

Use strict TypeScript, Vitest, runtime schemas, and minimal fixture repositories. Globally require at least 80% branch/function/line/statement coverage and target 95% for ownership, risk, state, and release primitives.

TDD slices: contracts/config safety floors; task parsing/state; multi-stack detector; persona composition; ownership/path adversaries; risk/router tables; gates/evidence/release; Obsidian round trips; foundation integration/CLI validation.

Fixtures cover Next.js/Supabase, Laravel/React, Flutter/Laravel, FastAPI, Spring, .NET, Go, mixed monorepo, and unknown repositories. Adversarial cases include traversal, absolute paths, symlink escape, ambiguous ownership, corrupt/version-old state, duplicate task IDs, malformed contracts, stale candidate evidence, and critical AUTO requests.

Verification order is build/typecheck, lint/format, unit/integration/CLI tests with coverage, security/dependency/secret review, and final diff review. Tests assert public policy outcomes and immutability, not implementation details.
