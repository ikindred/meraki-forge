import { describe, expect, it } from "vitest";
import {
  composeBootstrapPersona,
  proposeOwnership,
  detectStack,
} from "../packages/kernel/src/index.js";

describe("bootstrap ownership proposal", () => {
  it("creates only narrow rules backed by architecture evidence", () => {
    const proposal = proposeOwnership([
      {
        pattern: "apps/web/**",
        owner: "frontend-engineer",
        evidence: ["apps/web/package.json", "docs/architecture.md"],
      },
      {
        pattern: "apps/api/**",
        owner: "backend-engineer",
        evidence: ["apps/api/composer.json"],
      },
    ]);
    expect(proposal.rules).toHaveLength(2);
    expect(proposal.default_effect).toBe("deny");
    expect(proposal.rules.some((rule) => rule.pattern === "**")).toBe(false);
  });

  it("does not grant ambiguous or unsupported paths", () => {
    const proposal = proposeOwnership([
      {
        pattern: "packages/shared/**",
        owner: "frontend-engineer",
        evidence: ["packages/shared/package.json"],
      },
      {
        pattern: "packages/shared/**",
        owner: "backend-engineer",
        evidence: ["packages/shared/package.json"],
      },
      { pattern: "scripts/**", owner: "backend-engineer", evidence: [] },
    ]);
    expect(proposal.rules).toEqual([]);
    expect(proposal.ambiguities.map((entry) => entry.pattern)).toEqual([
      "packages/shared/**",
      "scripts/**",
    ]);
  });
});

describe("bootstrap persona composition", () => {
  it("changes expertise and title without changing authority", () => {
    const next = composeBootstrapPersona(
      {
        role: "frontend-engineer",
        title: "Frontend Engineer",
        capabilities: ["ui"],
        read_only: false,
      },
      detectStack([
        {
          path: "apps/web/package.json",
          content: '{"dependencies":{"next":"16","react":"19"}}',
        },
      ]),
      ["apps/web/**", "apps/api/**"],
      ["apps/web/**"],
    );
    const unknown = composeBootstrapPersona(
      {
        role: "frontend-engineer",
        title: "Frontend Engineer",
        capabilities: ["ui"],
        read_only: false,
      },
      { evidence: [], unknown: true },
      ["apps/web/**", "apps/api/**"],
      ["apps/web/**"],
    );
    expect(next.title).toContain("Next.js");
    expect(next.expertise).not.toEqual(unknown.expertise);
    expect(next.write_grant).toEqual(unknown.write_grant);
    expect(next.write_grant).toEqual(["apps/web/**"]);
  });
});
