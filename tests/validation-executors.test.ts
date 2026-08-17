import { describe, expect, it, vi } from "vitest";
import {
  AccessibilityValidator,
  CodeReviewValidator,
  QaValidator,
  SecurityValidator,
  type AccessibilityAuditInput,
  type CodeReviewInput,
  type QaValidationInput,
  type SecurityAuditInput,
} from "../packages/validation/src/executors.js";

const common = {
  task_id: "MF-300",
  candidate_commit: "a".repeat(40),
  worktree: "/repo/.forge/worktrees/MF-300",
} as const;

describe("independent validation executors", () => {
  it("gives QA only a scoped artifact writer and returns AC-linked findings", async () => {
    const write = vi.fn(() =>
      Promise.resolve(".forge/artifacts/MF-300/qa/result.json"),
    );
    const input: QaValidationInput = {
      ...common,
      acceptance_criteria: [
        { criterion_id: "AC-1", statement: "Reject guests" },
      ],
      test_scope: ["tests/**", "e2e/**"],
    };
    const validator = new QaValidator(
      {
        execute: async (received, capabilities) => {
          expect(received).toEqual(input);
          expect(Object.keys(capabilities)).toEqual(["artifacts"]);
          await capabilities.artifacts.write("qa/result.json", "{}");
          return {
            status: "FAIL",
            findings: [
              {
                finding_id: "QA-1",
                severity: "high",
                acceptance_criterion: "AC-1",
                evidence: [".forge/artifacts/MF-300/qa/result.json"],
                expected_owner: "backend-engineer",
                blocking: true,
                message: "Guest access is accepted",
              },
            ],
          };
        },
      },
      { write },
    );

    await expect(validator.run(input)).resolves.toMatchObject({
      status: "FAIL",
    });
    expect(write).toHaveBeenCalledWith("qa/result.json", "{}");
  });

  it("rejects malformed or unrecognized QA output at the runtime boundary", async () => {
    const validator = new QaValidator(
      {
        execute: () =>
          Promise.resolve({ status: "PASS", findings: [], surprise: true }),
      },
      { write: () => Promise.resolve("unused") },
    );
    await expect(
      validator.run({
        ...common,
        acceptance_criteria: [],
        test_scope: ["tests/**"],
      }),
    ).rejects.toThrow();
  });

  it("runs security without exposing any write capability", async () => {
    const input: SecurityAuditInput = {
      ...common,
      changed_files: ["src/auth.ts"],
    };
    const execute = vi.fn((received: SecurityAuditInput) => {
      expect(received).toEqual(input);
      return Promise.resolve({
        status: "FAIL" as const,
        findings: [
          {
            finding_id: "SEC-1",
            severity: "critical" as const,
            category: "authorization",
            affected_files: ["src/auth.ts"],
            evidence: ["src/auth.ts:20"],
            expected_owner: "backend-engineer",
            blocking: true,
            recommendation: "Enforce the resource owner check",
          },
        ],
      });
    });
    const result = await new SecurityValidator({ execute }).run(input);
    expect(execute.mock.calls[0]).toHaveLength(1);
    expect(result.findings[0]?.expected_owner).toBe("backend-engineer");
  });

  it("runs accessibility read-only and routes findings to frontend", async () => {
    const input: AccessibilityAuditInput = {
      ...common,
      changed_files: ["src/dialog.tsx"],
      viewports: ["desktop", "mobile"],
    };
    const execute = vi.fn(() =>
      Promise.resolve({
        status: "FAIL" as const,
        findings: [
          {
            finding_id: "A11Y-1",
            severity: "medium" as const,
            category: "keyboard_navigation",
            affected_files: ["src/dialog.tsx"],
            evidence: ["Tab leaves the open dialog"],
            expected_owner: "frontend-engineer" as const,
            blocking: true,
            message: "Focus is not trapped",
          },
        ],
      }),
    );
    const result = await new AccessibilityValidator({ execute }).run(input);
    expect(execute.mock.calls[0]).toHaveLength(1);
    expect(result.findings[0]?.expected_owner).toBe("frontend-engineer");
  });

  it.each(["APPROVED", "CHANGES_REQUESTED"] as const)(
    "limits reviewer decisions to %s",
    async (decision) => {
      const input: CodeReviewInput = {
        ...common,
        changed_files: ["src/domain.ts"],
      };
      const result = await new CodeReviewValidator({
        execute: () => Promise.resolve({ decision, findings: [] }),
      }).run(input);
      expect(result.decision).toBe(decision);
    },
  );

  it("rejects reviewer decisions outside the closed decision set", async () => {
    const validator = new CodeReviewValidator({
      execute: () => Promise.resolve({ decision: "PASS", findings: [] }),
    });
    await expect(
      validator.run({ ...common, changed_files: ["src/domain.ts"] }),
    ).rejects.toThrow();
  });

  it("requires every blocking review finding to identify an owner", async () => {
    const validator = new CodeReviewValidator({
      execute: () =>
        Promise.resolve({
          decision: "CHANGES_REQUESTED",
          findings: [
            {
              finding_id: "REV-1",
              severity: "high",
              category: "contract_correctness",
              affected_files: ["src/domain.ts"],
              evidence: ["Return type is incompatible"],
              blocking: true,
              message: "Public contract changed",
            },
          ],
        }),
    });
    await expect(
      validator.run({ ...common, changed_files: ["src/domain.ts"] }),
    ).rejects.toThrow();
  });
});
