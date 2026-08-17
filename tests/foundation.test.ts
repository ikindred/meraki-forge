import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectPolicySchema,
  TaskContractSchema,
  classifyRisk,
  composePersona,
  detectStack,
  evaluateRelease,
  normalizeRepoPath,
  planGates,
  resolveOwner,
  routeTask,
  startRepair,
  transitionState,
  validateBoundary,
  type OwnershipRule,
  type TaskState,
} from "../packages/kernel/src/index.js";
import { parseTaskMarkdown } from "../packages/adapters/src/task-markdown.js";
import { JsonStateStore } from "../packages/adapters/src/json-state-store.js";

const task = TaskContractSchema.parse({
  schema_version: "1",
  id: "MF-1",
  title: "Add frontend export feature",
  mode: "AUTO",
  priority: "P2",
  outcome: "Frontend users export records",
  acceptance_criteria: [{ id: "AC-1", text: "Filtered records are exported" }],
});
const policy = ProjectPolicySchema.parse({
  schema_version: "1",
  autonomy_ceiling: "MEDIUM",
  auto_merge: false,
  production_deploy: false,
});

describe("task contracts", () => {
  it("requires acceptance criteria for executable tasks", () =>
    expect(() =>
      TaskContractSchema.parse({ ...task, acceptance_criteria: [] }),
    ).toThrow());
  it("parses and freezes Obsidian frontmatter", () => {
    const parsed = parseTaskMarkdown(
      `---\nschema_version: "1"\nid: MF-2\ntitle: Plan API\nmode: PLAN\npriority: P2\noutcome: A reviewed plan\nacceptance_criteria: []\n---\nHuman notes`,
    );
    expect(parsed.notes).toBe("Human notes");
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it("rejects missing task frontmatter", () =>
    expect(() => parseTaskMarkdown("# loose note")).toThrow());
  it("rejects unsafe task frontmatter YAML", () => {
    expect(() =>
      parseTaskMarkdown("---\nid: one\nid: two\n---\nbody"),
    ).toThrow();
    expect(() =>
      parseTaskMarkdown(
        `---\n${"x: { y:".repeat(40)} 1${" }".repeat(40)}\n---\nbody`,
      ),
    ).toThrow();
  });
});

describe("stack adaptation", () => {
  it("retains evidence for multiple repository modules", () => {
    const profile = detectStack([
      {
        path: "web/package.json",
        content: JSON.stringify({
          dependencies: {
            next: "16",
            react: "19",
            "@supabase/supabase-js": "2",
          },
          devDependencies: { "@playwright/test": "1" },
        }),
      },
      {
        path: "mobile/pubspec.yaml",
        content: "dependencies:\n  flutter:\n    sdk: flutter",
      },
    ]);
    expect(profile.evidence.map((x) => x.name)).toEqual(
      expect.arrayContaining([
        "Next.js",
        "React",
        "Flutter",
        "Supabase/PostgreSQL",
        "Playwright",
      ]),
    );
  });
  it("is explicit for unknown stacks", () =>
    expect(
      detectStack([{ path: "README.md", content: "FastAPI is mentioned here" }])
        .unknown,
    ).toBe(true));
  it.each([
    [
      "composer.json",
      '{"require":{"laravel/framework":"12"}}',
      ["PHP", "Laravel"],
    ],
    ["pyproject.toml", "dependencies = ['fastapi']", ["Python", "FastAPI"]],
    ["pom.xml", "<artifactId>spring-core</artifactId>", ["Java", "Spring"]],
    ["app.csproj", "<Project />", ["C#", ".NET"]],
    ["go.mod", "module example", ["Go"]],
    ["Cargo.toml", "[package]", ["Rust"]],
    ["Dockerfile", "FROM node", ["Docker"]],
  ])("detects %s markers", (path, content, expected) =>
    expect(
      detectStack([{ path, content }]).evidence.map((x) => x.name),
    ).toEqual(expect.arrayContaining(expected)),
  );
  it("ignores malformed package metadata", () =>
    expect(detectStack([{ path: "package.json", content: "{" }]).unknown).toBe(
      true,
    ));
  it("adds expertise without widening grants", () => {
    const runtime = composePersona(
      {
        role: "frontend-engineer",
        title: "Frontend",
        capabilities: ["ui"],
        read_only: false,
      },
      detectStack([
        { path: "package.json", content: '{"dependencies":{"next":"16"}}' },
      ]),
      ["src/web/**", "src/server/**"],
      ["src/web/**"],
    );
    expect(runtime.expertise).toContain("Next.js");
    expect(runtime.write_grant).toEqual(["src/web/**"]);
  });
});

describe("ownership", () => {
  const rules: OwnershipRule[] = [
    { pattern: "src/web/**", owner: "frontend-engineer", effect: "allow" },
    { pattern: "src/server/**", owner: "backend-engineer", effect: "allow" },
    {
      pattern: "src/web/secrets/**",
      owner: "frontend-engineer",
      effect: "forbid",
    },
  ];
  it("fails closed on invalid and unowned paths", () => {
    expect(() => normalizeRepoPath("../secret")).toThrow();
    expect(resolveOwner("README.md", rules).owner).toBeUndefined();
  });
  it("rejects the whole output for cross-domain or forbidden writes", () => {
    const result = validateBoundary(
      "frontend-engineer",
      ["src/web/card.tsx", "src/server/pay.ts"],
      rules,
      ["src/web/**"],
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.expected_owner).toBe("backend-engineer");
  });
  it("allows only configured and assigned ownership", () =>
    expect(
      validateBoundary("frontend-engineer", ["src/web/card.tsx"], rules, [
        "src/web/**",
      ]).ok,
    ).toBe(true));
  it("forbid wins over allow", () =>
    expect(resolveOwner("src/web/secrets/key.ts", rules).forbidden).toBe(true));
  it("detects ambiguous equal-specificity ownership", () =>
    expect(
      resolveOwner("shared/file.ts", [
        { pattern: "shared/**", owner: "frontend-engineer", effect: "allow" },
        { pattern: "shared/**", owner: "backend-engineer", effect: "allow" },
      ]).ambiguous,
    ).toBe(true));
  it("normalizes Windows separators and rejects absolute paths", () => {
    expect(normalizeRepoPath("src\\web\\a.ts")).toBe("src/web/a.ts");
    expect(() => normalizeRepoPath("C:\\secret")).toThrow();
  });
});

describe("risk and routing", () => {
  it("takes maximum risk and blocks critical AUTO", () => {
    const critical = TaskContractSchema.parse({
      ...task,
      outcome: "Destructive production database action",
    });
    const risk = classifyRisk(critical);
    expect(risk.level).toBe("CRITICAL");
    expect(
      routeTask(critical, risk, ["frontend-engineer"], policy).disposition,
    ).toBe("DISCUSS");
  });
  it("classifies destructive production synonyms as critical", () => {
    const destructive = TaskContractSchema.parse({
      ...task,
      outcome: "Delete all production customer records",
    });
    expect(classifyRisk(destructive).level).toBe("CRITICAL");
  });
  it("requires explicit HIGH autonomy", () => {
    const high = TaskContractSchema.parse({
      ...task,
      title: "Frontend authentication architecture",
    });
    expect(
      routeTask(high, classifyRisk(high), ["frontend-engineer"], policy)
        .disposition,
    ).toBe("DISCUSS");
  });
  it("routes normal AUTO work to a configured strict owner", () =>
    expect(
      routeTask(task, classifyRisk(task), ["frontend-engineer"], policy).owners,
    ).toEqual(["frontend-engineer"]));
  it("never invents a generalist for an unknown domain", () => {
    const unknown = TaskContractSchema.parse({
      ...task,
      title: "Improve quantum compiler",
      outcome: "Better output",
    });
    expect(
      routeTask(unknown, classifyRisk(unknown), [], policy).disposition,
    ).toBe("BLOCKED");
  });
  it.each([
    ["PLAN", "PLAN_ONLY"],
    ["REVIEW", "READ_ONLY_REVIEW"],
    ["DISCUSS", "DISCUSS"],
    ["HOLD", "BLOCKED"],
  ] as const)("honors %s mode", (mode, disposition) =>
    expect(
      routeTask(
        TaskContractSchema.parse({ ...task, mode }),
        classifyRisk(task),
        ["frontend-engineer"],
        policy,
      ).disposition,
    ).toBe(disposition),
  );
  it("hard-codes production read-only personas", () =>
    expect(
      validateBoundary(
        "security-auditor",
        ["src/web/card.tsx"],
        [{ pattern: "src/web/**", owner: "security-auditor", effect: "allow" }],
        ["src/web/**"],
      ).ok,
    ).toBe(false));
  it("keeps all gates for a hotfix", () => {
    const hotfix = TaskContractSchema.parse({ ...task, mode: "HOTFIX" });
    expect(
      routeTask(hotfix, classifyRisk(hotfix), ["frontend-engineer"], policy)
        .required_gates,
    ).toContain("review");
  });
});

describe("state", () => {
  const base: TaskState = {
    schema_version: "1",
    revision: 0,
    task_id: "MF-1",
    mode: "AUTO",
    status: "READY",
    phase: "AUTHORIZED",
    repair_attempt: 0,
    manifest_revision: 0,
    branch: null,
    worktree: null,
    base_sha: null,
    candidate_sha: null,
    risk: null,
    agents: [],
    dependencies: [],
    gates: [],
    evidence_ids: [],
    pr: null,
    blocker_reason: null,
    updated_at: "2026-08-11T00:00:00.000Z",
    transitions: [],
  };
  it("records immutable legal transitions", () => {
    const next = transitionState(
      base,
      "IN_PROGRESS",
      "director",
      "claimed",
      "2026-08-11T01:00:00.000Z",
    );
    expect(next.revision).toBe(1);
    expect(base.status).toBe("READY");
    expect(next.transitions).toHaveLength(1);
  });
  it("rejects illegal and automated acceptance", () => {
    expect(() =>
      transitionState(base, "DONE", "bot", "skip", "2026-08-11T01:00:00.000Z"),
    ).toThrow();
    const review = { ...base, status: "REVIEW" as const };
    expect(() =>
      transitionState(
        review,
        "DONE",
        "bot",
        "accept",
        "2026-08-11T01:00:00.000Z",
      ),
    ).toThrow();
  });
  it("blocks before a fourth repair", () =>
    expect(
      startRepair(
        { ...base, status: "IN_PROGRESS", repair_attempt: 3 },
        "2026-08-11T01:00:00.000Z",
      ).status,
    ).toBe("BLOCKED"));
  it("increments an allowed repair", () =>
    expect(
      startRepair(
        { ...base, status: "IN_PROGRESS" },
        "2026-08-11T01:00:00.000Z",
      ).repair_attempt,
    ).toBe(1));
  it("persists atomically and enforces optimistic revision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-state-"));
    const path = join(dir, "state.json");
    const store = new JsonStateStore();
    try {
      await writeFile(path, JSON.stringify(base));
      await store.save(path, { ...base, revision: 1 }, 0);
      expect((await store.load(path)).revision).toBe(1);
      await expect(
        store.save(path, { ...base, revision: 2 }, 0),
      ).rejects.toThrow("revision conflict");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  it("persists release-binding state fields outside chat history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-state-rich-"));
    const path = join(dir, "state.json");
    const store = new JsonStateStore();
    try {
      const rich = {
        ...base,
        manifest_revision: 3,
        branch: "forge/MF-1",
        worktree: ".worktrees/MF-1",
        base_sha: "base",
        candidate_sha: "candidate",
        risk: "MEDIUM" as const,
        agents: ["frontend-engineer"],
        dependencies: ["DEP-1"],
        gates: [],
        evidence_ids: ["E-1"],
        pr: null,
        blocker_reason: null,
      };
      await writeFile(path, JSON.stringify(base));
      await store.save(path, rich, 0);
      expect(await store.load(path)).toMatchObject({
        manifest_revision: 3,
        candidate_sha: "candidate",
        evidence_ids: ["E-1"],
      });
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("release eligibility", () => {
  const evidence = {
    id: "E-1",
    acceptance_ids: ["AC-1"],
    kind: "test",
    location: "report.xml",
    sha256: "a".repeat(64),
    tool: "vitest",
    result: "PASS",
    captured_at: "2026-08-11T01:00:00.000Z",
    candidate_sha: "abc",
  };
  it("binds passing evidence and gates to the candidate", () => {
    const result = evaluateRelease({
      task,
      manifest_revision: 2,
      candidate_sha: "abc",
      required_gate_ids: ["tests"],
      required_evidence_kinds: ["test"],
      gates: [
        {
          id: "tests",
          status: "PASS",
          candidate_sha: "abc",
          evidence_ids: ["E-1"],
          reason: "passed",
        },
      ],
      evidence: [evidence],
      ownership_clean: true,
      unresolved_findings: 0,
      documentation_complete: true,
      known_limitations_documented: true,
    });
    expect(result.eligible).toBe(true);
    expect(result.proof).toMatchObject({
      task_id: "MF-1",
      manifest_revision: 2,
      candidate_sha: "abc",
    });
  });
  it("fails closed for stale evidence and skipped gates", () => {
    const result = evaluateRelease({
      task,
      manifest_revision: 2,
      candidate_sha: "new",
      required_gate_ids: ["tests"],
      required_evidence_kinds: ["test"],
      gates: [
        {
          id: "tests",
          status: "SKIPPED",
          candidate_sha: "new",
          evidence_ids: [],
          reason: "",
        },
      ],
      evidence: [evidence],
      ownership_clean: true,
      unresolved_findings: 0,
      documentation_complete: true,
      known_limitations_documented: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        "REQUIRED_GATE_NOT_PASSING",
        "ACCEPTANCE_EVIDENCE_INCOMPLETE",
      ]),
    );
  });
  it("rejects invalid records, findings, ownership, and missing docs", () => {
    const result = evaluateRelease({
      task,
      manifest_revision: 2,
      candidate_sha: "abc",
      required_gate_ids: ["ownership", "tests"],
      required_evidence_kinds: ["test"],
      gates: [{}],
      evidence: [{}],
      ownership_clean: false,
      unresolved_findings: 1,
      documentation_complete: false,
      known_limitations_documented: false,
    });
    expect(result.failures).toEqual(
      expect.arrayContaining([
        "INVALID_GATE_RESULT",
        "INVALID_EVIDENCE",
        "OWNERSHIP_NOT_CLEAN",
        "UNRESOLVED_FINDINGS",
        "DOCUMENTATION_INCOMPLETE",
      ]),
    );
  });
  it("cannot pass with an omitted frozen gate plan", () => {
    const result = evaluateRelease({
      task,
      manifest_revision: 2,
      candidate_sha: "abc",
      required_gate_ids: ["ownership", "tests", "qa", "review"],
      required_evidence_kinds: ["test"],
      gates: [],
      evidence: [evidence],
      ownership_clean: true,
      unresolved_findings: 0,
      documentation_complete: true,
      known_limitations_documented: true,
    });
    expect(result.failures).toContain("REQUIRED_GATE_MISSING");
  });
  it("rejects gate evidence linked to a stale candidate", () => {
    const result = evaluateRelease({
      task,
      manifest_revision: 2,
      candidate_sha: "new",
      required_gate_ids: ["tests"],
      required_evidence_kinds: [],
      gates: [
        {
          id: "tests",
          status: "PASS",
          candidate_sha: "new",
          evidence_ids: ["E-1"],
          reason: "passed",
        },
      ],
      evidence: [evidence],
      ownership_clean: true,
      unresolved_findings: 0,
      documentation_complete: true,
      known_limitations_documented: true,
    });
    expect(result.failures).toContain("GATE_EVIDENCE_REFERENCE_INVALID");
  });
});

describe("safety floors and gate planning", () => {
  it("makes auto-merge and production deploy impossible in valid configuration", () => {
    expect(() =>
      ProjectPolicySchema.parse({
        schema_version: "1",
        autonomy_ceiling: "MEDIUM",
        auto_merge: true,
        production_deploy: false,
      }),
    ).toThrow();
    expect(
      ProjectPolicySchema.parse({
        schema_version: "1",
        autonomy_ceiling: "HIGH",
        auto_merge: false,
        production_deploy: false,
      }).auto_create_pr,
    ).toBe(false);
  });
  it("derives impact gates independently of task wording", () => {
    const plan = planGates(["ui", "database", "auth"], "HIGH");
    expect(plan.required).toEqual(
      expect.arrayContaining([
        "accessibility",
        "migration-validation",
        "rollback-review",
        "security",
      ]),
    );
    expect(plan.evidence).toEqual(
      expect.arrayContaining([
        "demo-video",
        "integrity-report",
        "negative-access-tests",
      ]),
    );
  });
});
