# Implementation roadmap

## Phase 0 — complete

Reference inspection and categorized analysis.

## Phase 1 — foundation (current)

1. Constitution, authority, architecture, task/state, ownership, risk, contracts, evidence, bootstrap design, and test strategy.
2. Strict TypeScript/schema/test toolchain.
3. Canonical task, state, message, stack, persona, ownership, gate, evidence, and release contracts.
4. Stack evidence detector with multi-stack fixtures.
5. Persona composer proving expertise cannot widen grants.
6. Fail-closed ownership compiler/matcher and violation report.
7. Risk classifier and declarative task router.
8. Pure state reducer, persisted JSON adapter, lease/revision interfaces, and repair cap.
9. Gate planner, evidence validator, and PR eligibility evaluator.
10. Architecture consistency and independent code/security review.

## Later phases

Phase 2 implements Director, Coordinator, worktrees, claims, dispatch, dependency routing, attribution, repair, and integration. Phase 3 implements independent validation and proof capture. Phase 4 implements PR delivery, Obsidian REVIEW projection, reporting, and notifications. Phase 5 implements bootstrap, doctor, validate, and upgrade.

## Phase 1 exit criteria

Contracts are versioned/schema-valid; core policies are deterministic and immutable; cross-stack fixtures compose without weakening ownership; invalid/unsafe configuration fails closed; tests and coverage pass; docs identify remaining effectful work without claiming it exists.
