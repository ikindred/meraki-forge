import { describe, expect, it } from "vitest";
import {
  composePersona,
  createDependencyRequests,
  detectStack,
  validateBoundary,
  type OwnershipRule,
  type Persona,
} from "../packages/kernel/src/index.js";

const rules: readonly OwnershipRule[] = [
  { pattern: "src/frontend/**", owner: "frontend-engineer", effect: "allow" },
  { pattern: "src/backend/**", owner: "backend-engineer", effect: "allow" },
  { pattern: "database/**", owner: "database-architect", effect: "allow" },
];

function check(
  persona: Persona,
  paths: readonly string[],
  grant: readonly string[],
) {
  return validateBoundary(persona, paths, rules, grant);
}

describe("implementation ownership matrix", () => {
  it("allows frontend writes only in its frontend grant", () =>
    expect(
      check("frontend-engineer", ["src/frontend/card.tsx"], ["src/frontend/**"])
        .ok,
    ).toBe(true));
  it.each([
    ["src/backend/payment.ts", "backend-engineer"],
    ["database/migrations/001.sql", "database-architect"],
  ] as const)("rejects frontend cross-domain write %s", (path, owner) =>
    expect(
      check("frontend-engineer", [path], ["src/frontend/**"]).violations,
    ).toContainEqual(
      expect.objectContaining({
        code: "AGENT_BOUNDARY_VIOLATION",
        expected_owner: owner,
      }),
    ),
  );
  it("allows backend writes only in its backend grant", () =>
    expect(
      check("backend-engineer", ["src/backend/payment.ts"], ["src/backend/**"])
        .ok,
    ).toBe(true));
  it.each([
    ["src/frontend/card.tsx", "frontend-engineer"],
    ["database/migrations/001.sql", "database-architect"],
  ] as const)("rejects backend cross-domain write %s", (path, owner) =>
    expect(
      check("backend-engineer", [path], ["src/backend/**"]).violations,
    ).toContainEqual(
      expect.objectContaining({
        code: "AGENT_BOUNDARY_VIOLATION",
        expected_owner: owner,
      }),
    ),
  );
  it("does not let a task grant override the configured database owner", () =>
    expect(
      check(
        "backend-engineer",
        ["database/migrations/001.sql"],
        ["src/backend/**", "database/**"],
      ).ok,
    ).toBe(false));
  it("allows a separately configured database assignment only when project ownership also assigns it", () => {
    const explicitRules = [
      {
        pattern: "database/migrations/safe/**",
        owner: "backend-engineer",
        effect: "allow",
      },
    ] as const;
    expect(
      validateBoundary(
        "backend-engineer",
        ["database/migrations/safe/001.sql"],
        explicitRules,
        ["database/migrations/safe/**"],
      ).ok,
    ).toBe(true);
  });
  it("allows database persona only in database-owned paths", () => {
    expect(
      check("database-architect", ["database/schema.sql"], ["database/**"]).ok,
    ).toBe(true);
    expect(
      check("database-architect", ["src/backend/model.ts"], ["database/**"]).ok,
    ).toBe(false);
  });
  it("keeps default deny for unowned files even when the assignment claims them", () =>
    expect(
      check("frontend-engineer", ["scripts/unowned.ts"], ["scripts/**"])
        .violations,
    ).toContainEqual(expect.objectContaining({ reason: "unowned-path" })));
});

describe("production read-only persona floor", () => {
  it.each([
    "qa-engineer",
    "security-auditor",
    "accessibility-auditor",
    "code-reviewer",
    "evidence-agent",
    "release-agent",
  ] as const)("denies %s production implementation changes", (persona) =>
    expect(
      validateBoundary(
        persona,
        ["src/frontend/card.tsx"],
        [{ pattern: "src/frontend/**", owner: persona, effect: "allow" }],
        ["src/frontend/**"],
      ).violations,
    ).toContainEqual(
      expect.objectContaining({
        code: "AGENT_BOUNDARY_VIOLATION",
        reason: "production-read-only-persona",
      }),
    ),
  );
});

describe("dependency handoff", () => {
  it("turns a cross-domain boundary violation into a schema-valid dependency request", () => {
    const boundary = check(
      "frontend-engineer",
      ["src/backend/payment.ts"],
      ["src/frontend/**"],
    );
    const requests = createDependencyRequests(
      {
        task_id: "MF-10",
        run_id: "RUN-1",
        from: "frontend-engineer",
        created_at: "2026-08-11T00:00:00.000Z",
        acceptance_ids: ["AC-2"],
        required_output: "Backend payment API contract",
      },
      boundary,
    );
    const request = requests[0];
    expect(request?.kind).toBe("DEPENDENCY_REQUEST");
    if (!request || request.kind !== "DEPENDENCY_REQUEST")
      throw new Error("Expected dependency request");
    expect(request.from).toBe("frontend-engineer");
    expect(request.to).toBe("engineering-coordinator");
    expect(request.payload.requested_owner).toBe("backend-engineer");
    expect(request.payload.affected_paths).toEqual(["src/backend/payment.ts"]);
    expect(request.payload.blocking).toBe(true);
  });
  it("does not manufacture an owner for an unowned path", () =>
    expect(() =>
      createDependencyRequests(
        {
          task_id: "MF-10",
          run_id: "RUN-1",
          from: "frontend-engineer",
          created_at: "2026-08-11T00:00:00.000Z",
          acceptance_ids: [],
          required_output: "Unknown",
        },
        check("frontend-engineer", ["unknown/file"], ["unknown/**"]),
      ),
    ).toThrow("expected owner"));
});

describe("stack adaptation authority", () => {
  it("changes expertise but leaves the same ownership intersection", () => {
    const role = {
      role: "frontend-engineer" as const,
      title: "Frontend",
      capabilities: ["ui"],
      read_only: false,
    };
    const grant = ["src/frontend/**", "src/backend/**"];
    const scope = ["src/frontend/**"];
    const next = composePersona(
      role,
      detectStack([
        { path: "package.json", content: '{"dependencies":{"next":"16"}}' },
      ]),
      grant,
      scope,
    );
    const react = composePersona(
      role,
      detectStack([
        { path: "package.json", content: '{"dependencies":{"react":"19"}}' },
      ]),
      grant,
      scope,
    );
    expect(next.expertise).not.toEqual(react.expertise);
    expect(next.write_grant).toEqual(react.write_grant);
    expect(next.write_grant).toEqual(["src/frontend/**"]);
  });
});
