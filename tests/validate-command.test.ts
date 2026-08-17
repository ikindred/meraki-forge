import { describe, expect, it } from "vitest";
import { validateProject } from "../packages/execution/src/project-validator.js";

const safe = {
  schema_versions: { project: "1", ownership: "1", providers: "1" },
  supported_schema_versions: { project: "1", ownership: "1", providers: "1" },
  repository_path: "/work/acme",
  state_root: "/work/acme/.forge/state",
  artifact_root: "/work/acme/.forge/artifacts",
  command_center_path: "/vault/Acme/AI Engineering",
  other_command_centers: ["/vault/Beta/AI Engineering"],
  ownership: { default_deny: true, ambiguous_paths: [] },
  personas: {
    qa: ["tests/**"],
    security: [],
    accessibility: [],
    reviewer: [],
    evidence: [".forge/artifacts/**"],
    release: [],
  },
  delivery: { auto_merge: false, production_deploy: false },
  stack_composition_widens_ownership: false,
  dependency_handoffs_valid: true,
  evidence_policy_valid: true,
  provider_config_valid: true,
  scheduler_contracts_valid: true,
  mcp: {
    enabled: true,
    plaintext_secret: false,
    production_write: false,
    default_read_only: true,
  },
} as const;

describe("forge validate", () => {
  it("returns a strict machine-readable PASS report for safe configuration", () => {
    const report = validateProject(safe);
    expect(report.status).toBe("PASS");
    expect(report.exit_code).toBe(0);
    expect(report.checks.every((check) => check.status === "PASS")).toBe(true);
  });

  it("fails closed on governance floors, containment, ambiguity, and schema drift", () => {
    const report = validateProject({
      ...safe,
      schema_versions: { ...safe.schema_versions, project: "99" },
      state_root: "/tmp/state",
      command_center_path: "/vault/Beta/AI Engineering",
      ownership: { default_deny: false, ambiguous_paths: ["src/shared.ts"] },
      personas: { ...safe.personas, security: ["src/**"], qa: ["src/**"] },
      delivery: { auto_merge: true, production_deploy: true },
      stack_composition_widens_ownership: true,
      mcp: { ...safe.mcp, production_write: true, plaintext_secret: true },
    });
    expect(report.status).toBe("FAIL");
    expect(report.exit_code).toBe(1);
    expect(
      report.checks
        .filter((check) => check.status === "FAIL")
        .map((check) => check.id),
    ).toEqual(
      expect.arrayContaining([
        "schemas",
        "repo-containment",
        "command-center-isolation",
        "default-deny",
        "ownership-ambiguity",
        "persona-floors",
        "delivery-safety",
        "stack-authority",
        "mcp-safety",
      ]),
    );
  });
});
