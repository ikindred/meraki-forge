import { describe, expect, it } from "vitest";
import {
  validateExecutionBoundary,
  type OwnershipRule,
} from "../packages/kernel/src/index.js";
import { OwnershipValidationBoundary } from "../packages/adapters/src/validation-boundary-verifier.js";

const rules: readonly OwnershipRule[] = [
  { pattern: "tests/**", owner: "qa-engineer", effect: "allow" },
  {
    pattern: ".forge/artifacts/MF-3/**",
    owner: "evidence-agent",
    effect: "allow",
  },
  { pattern: "src/**", owner: "frontend-engineer", effect: "allow" },
];

describe("Phase 3 validation persona boundaries", () => {
  it("allows evidence writes only inside the owned and granted task namespace", () => {
    expect(
      validateExecutionBoundary(
        "evidence-agent",
        [".forge/artifacts/MF-3/SUMMARY.md"],
        rules,
        [".forge/artifacts/MF-3/**"],
      ).ok,
    ).toBe(true);
    for (const path of [
      ".forge/artifacts/MF-4/SUMMARY.md",
      "tests/proof.test.ts",
      "src/page.tsx",
      "../MF-3/SUMMARY.md",
    ]) {
      expect(
        validateExecutionBoundary("evidence-agent", [path], rules, [
          ".forge/artifacts/MF-3/**",
        ]).ok,
      ).toBe(false);
    }
  });

  it.each([
    "security-auditor",
    "accessibility-auditor",
    "code-reviewer",
  ] as const)("keeps %s read-only even for evidence paths", (persona) => {
    expect(
      validateExecutionBoundary(
        persona,
        [".forge/artifacts/MF-3/report.json"],
        rules,
        [".forge/artifacts/MF-3/**"],
      ).ok,
    ).toBe(false);
  });

  it("keeps QA confined to explicitly owned and granted non-production paths", () => {
    expect(
      validateExecutionBoundary("qa-engineer", ["tests/flow.test.ts"], rules, [
        "tests/**",
      ]).ok,
    ).toBe(true);
    expect(
      validateExecutionBoundary("qa-engineer", ["src/page.tsx"], rules, [
        "tests/**",
      ]).ok,
    ).toBe(false);
  });

  it("exposes the same compiled ownership policy through the orchestrator adapter", async () => {
    const boundary = new OwnershipValidationBoundary(rules);
    await expect(
      boundary.assertAllowed(
        "qa-engineer",
        ["tests/flow.test.ts"],
        ["tests/**"],
      ),
    ).resolves.toBeUndefined();
    await expect(
      boundary.assertAllowed("qa-engineer", ["src/page.tsx"], ["tests/**"]),
    ).rejects.toThrow("VALIDATOR_WRITE_VIOLATION:src/page.tsx");
  });
});
