import { describe, expect, it } from "vitest";
import { ForgeMessageSchema } from "../packages/kernel/src/contracts.js";
import {
  DispatchRecordSchema,
  ExecutionManifestSchema,
  validateExecutionBoundary,
} from "../packages/kernel/src/execution.js";
import {
  addDependencyEdge,
  createDependencyNode,
  runnableNodes,
  routeDependencyMessage,
} from "../packages/kernel/src/dependency-graph.js";
import {
  claimLease,
  heartbeatLease,
  takeOverStaleLease,
} from "../packages/kernel/src/lease.js";
import {
  applyRepairResult,
  createRepairState,
  nextRepairDispatch,
} from "../packages/kernel/src/repair.js";
import {
  classifyIntegrationChanges,
  createSemanticConflict,
} from "../packages/kernel/src/integration.js";

const t0 = "2026-08-11T00:00:00.000Z";
const t1 = "2026-08-11T00:01:00.000Z";

describe("durable leases", () => {
  it("claims READY tasks exclusively and heartbeats immutably", () => {
    const lease = claimLease({
      task_id: "MF-20",
      status: "READY",
      authorized: true,
      owner: "coord-a",
      now: t0,
      lease_until: "2026-08-11T00:05:00.000Z",
      branch: "forge/mf-20",
      worktree: "/repo/.forge/worktrees/mf-20",
      base_commit: "a".repeat(40),
      current_commit: "a".repeat(40),
      revision: 0,
    });
    expect(() =>
      claimLease({
        task_id: "MF-20",
        status: "IN_PROGRESS",
        authorized: true,
        owner: "coord-b",
        now: t1,
        lease_until: "2026-08-11T00:06:00.000Z",
        branch: lease.branch,
        worktree: lease.worktree,
        base_commit: lease.base_commit,
        current_commit: lease.current_commit,
        revision: 1,
        existing: lease,
      }),
    ).toThrow("active lease");
    const beat = heartbeatLease(
      lease,
      lease.lease_id,
      "coord-a",
      t1,
      "2026-08-11T00:06:00.000Z",
      0,
    );
    expect(beat).toMatchObject({ updated_at: t1, revision: 1 });
    expect(lease.revision).toBe(0);
  });

  it("requires explicit stale takeover and optimistic revision", () => {
    const old = claimLease({
      task_id: "MF-20",
      status: "READY",
      authorized: true,
      owner: "coord-a",
      now: t0,
      lease_until: t1,
      branch: "forge/mf-20",
      worktree: "/w",
      base_commit: "a".repeat(40),
      current_commit: "a".repeat(40),
      revision: 4,
    });
    expect(() =>
      claimLease({
        task_id: "MF-20",
        status: "IN_PROGRESS",
        authorized: true,
        owner: "coord-b",
        now: "2026-08-11T00:02:00.000Z",
        lease_until: "2026-08-11T00:07:00.000Z",
        branch: old.branch,
        worktree: old.worktree,
        base_commit: old.base_commit,
        current_commit: old.current_commit,
        revision: 5,
        existing: old,
      }),
    ).toThrow("explicit takeover");
    const next = takeOverStaleLease(old, {
      owner: "coord-b",
      now: "2026-08-11T00:02:00.000Z",
      lease_until: "2026-08-11T00:07:00.000Z",
      expected_revision: 4,
    });
    expect(next.owner).toBe("coord-b");
    expect(next.revision).toBe(5);
  });
});

describe("execution contracts and graph", () => {
  it("validates a deterministic manifest and least-authority dispatch", () => {
    const manifest = ExecutionManifestSchema.parse({
      schema_version: "1",
      revision: 1,
      task_id: "MF-20",
      run_id: "R1",
      created_at: t0,
      stack_profile: ["TypeScript"],
      nodes: [
        {
          id: "front",
          persona_id: "frontend-engineer",
          dependencies: [],
          ownership_scope: ["src/frontend/**"],
          acceptance_ids: ["AC-1"],
          status: "PENDING",
        },
      ],
    });
    const dispatch = DispatchRecordSchema.parse({
      schema_version: "1",
      id: "D1",
      task_id: manifest.task_id,
      run_id: manifest.run_id,
      persona_id: "frontend-engineer",
      execution_node_id: "front",
      ownership_scope: ["src/frontend/**"],
      repository_path: "/repo",
      worktree_path: "/repo/.forge/worktrees/mf-20",
      stack_profile: manifest.stack_profile,
      relevant_contracts: ["api"],
      acceptance_criteria: ["AC-1"],
      dependencies: [],
      expected_output_schema: "forge.agent-output/v1",
      stop_conditions: ["boundary violation"],
    });
    expect(dispatch.ownership_scope).toEqual(
      manifest.nodes[0]?.ownership_scope,
    );
  });

  it("returns deterministic runnable nodes and deduplicates completed work", () => {
    const nodes = [
      { id: "b", dependencies: ["a"], status: "PENDING" as const },
      { id: "a", dependencies: [], status: "COMPLETED" as const },
      { id: "c", dependencies: [], status: "PENDING" as const },
    ];
    expect(runnableNodes(nodes).map((node) => node.id)).toEqual(["b", "c"]);
    expect(runnableNodes(nodes, new Set(["b"])).map((node) => node.id)).toEqual(
      ["c"],
    );
    expect(() => addDependencyEdge(nodes, "a", "b")).toThrow("cycle");
  });

  it("routes dependency requests to the expected specialist and blocks requester", () => {
    const message = ForgeMessageSchema.parse({
      kind: "DEPENDENCY_REQUEST",
      schema_version: "1",
      id: "DEP-1",
      task_id: "MF-20",
      run_id: "R1",
      from: "frontend-engineer",
      to: "engineering-coordinator",
      created_at: t0,
      payload: {
        reason: "API needed",
        affected_paths: ["src/backend/a.ts"],
        blocking: true,
        requested_owner: "backend-engineer",
        domain: "backend",
        required_output: "API contract",
        acceptance_ids: ["AC-1"],
      },
    });
    if (message.kind !== "DEPENDENCY_REQUEST") throw new Error("bad fixture");
    const node = createDependencyNode(message);
    expect(node.persona_id).toBe("backend-engineer");
    expect(
      routeDependencyMessage(message, "front", [
        { id: "front", dependencies: [], status: "RUNNING" },
      ]),
    ).toMatchObject({ blocked_node_id: "front", specialist_node: node });
  });
});

describe("execution boundary", () => {
  it("allows QA artifacts but never production implementation", () => {
    const qaRules = [
      "tests/**",
      "e2e/**",
      ".forge/artifacts/**",
      "test-results/**",
      "playwright-report/**",
    ].map((pattern) => ({
      pattern,
      owner: "qa-engineer" as const,
      effect: "allow" as const,
    }));
    const qaGrant = qaRules.map((rule) => rule.pattern);
    expect(
      validateExecutionBoundary(
        "qa-engineer",
        [
          "tests/a.test.ts",
          "e2e/a.spec.ts",
          ".forge/artifacts/report.json",
          "test-results/out.xml",
          "playwright-report/index.html",
        ],
        qaRules,
        qaGrant,
      ),
    ).toEqual({ ok: true, violations: [] });
    expect(
      validateExecutionBoundary("qa-engineer", ["src/app.ts"], qaRules, qaGrant)
        .violations[0]?.reason,
    ).toBe("qa-production-write");
    expect(
      validateExecutionBoundary(
        "qa-engineer",
        ["tests/../src/app.ts"],
        qaRules,
        qaGrant,
      ).violations[0]?.reason,
    ).toBe("invalid-or-escaping-path");
    expect(
      validateExecutionBoundary(
        "security-auditor",
        ["tests/a.test.ts"],
        qaRules,
        qaGrant,
      ).ok,
    ).toBe(false);
    expect(
      validateExecutionBoundary(
        "qa-engineer",
        ["tests/unowned.test.ts"],
        [],
        qaGrant,
      ).violations[0]?.reason,
    ).toBe("qa-artifact-not-owned-or-granted");
  });
});

describe("repair and integration policy", () => {
  it("dispatches findings to their owner and blocks after three failed rounds", () => {
    let state = createRepairState("MF-20", [
      {
        id: "F1",
        expected_owner: "backend-engineer",
        summary: "fix",
        affected_paths: ["src/backend/a.ts"],
      },
    ]);
    expect(nextRepairDispatch(state)?.persona_id).toBe("backend-engineer");
    state = applyRepairResult(
      state,
      { successful: false, result: "still broken", remaining_blocker: "F1" },
      t0,
    );
    state = applyRepairResult(
      state,
      { successful: false, result: "still broken", remaining_blocker: "F1" },
      t0,
    );
    state = applyRepairResult(
      state,
      { successful: false, result: "still broken", remaining_blocker: "F1" },
      t0,
    );
    expect(state).toMatchObject({
      attempts: 3,
      status: "BLOCKED",
      remaining_blocker: "F1",
    });
  });

  it("allows only mechanical integration and emits schema-valid semantic conflict", () => {
    expect(
      classifyIntegrationChanges([
        { path: "package-lock.json", kind: "LOCKFILE_REGENERATION" },
        { path: "src/a.ts", kind: "CONFLICT_MARKER_RESOLUTION" },
      ]).ok,
    ).toBe(true);
    expect(
      classifyIntegrationChanges([
        { path: "src/a.ts", kind: "PRODUCT_BEHAVIOR" },
      ]),
    ).toMatchObject({ ok: false, reason: "semantic-change-required" });
    expect(
      ForgeMessageSchema.safeParse(
        createSemanticConflict({
          id: "SC-1",
          task_id: "MF-20",
          run_id: "R1",
          created_at: t0,
          affected_paths: ["src/a.ts"],
          reason: "owners disagree",
          alternatives: ["A", "B"],
        }),
      ).success,
    ).toBe(true);
  });
});
