import { describe, expect, it } from "vitest";
import {
  AccessibilityFindingSchema,
  QAFindingSchema,
  ReviewerResultSchema,
  SecurityFindingSchema,
  ValidationGateResultSchema,
} from "../packages/kernel/src/validation-contracts.js";
import { planValidationGates } from "../packages/kernel/src/validation-plan.js";
import {
  AcceptanceProofSchema,
  evaluateAcceptanceCompleteness,
} from "../packages/kernel/src/acceptance.js";
import {
  EvidenceManifestSchema,
  evaluateEvidenceManifest,
} from "../packages/kernel/src/evidence-manifest.js";

const sha = "a".repeat(40);
const nextSha = "b".repeat(40);
const at = "2026-08-11T00:00:00.000Z";

describe("validation contracts", () => {
  it.each(["PASS", "FAIL", "NOT_APPLICABLE"] as const)(
    "accepts the explicit gate status %s",
    (status) => {
      const value = {
        schema_version: "1",
        gate: "QA",
        status,
        candidate_commit: sha,
        evidence_refs: status === "PASS" ? ["EV-1"] : [],
        finding_ids: status === "FAIL" ? ["QA-1"] : [],
        reason: status === "NOT_APPLICABLE" ? "No executable surface" : null,
        completed_at: at,
      };
      expect(ValidationGateResultSchema.safeParse(value).success).toBe(true);
    },
  );

  it("rejects vague statuses and unjustified not-applicable results", () => {
    const base = {
      schema_version: "1",
      gate: "QA",
      candidate_commit: sha,
      evidence_refs: [],
      finding_ids: [],
      reason: null,
      completed_at: at,
    };
    expect(
      ValidationGateResultSchema.safeParse({ ...base, status: "SUCCESS" })
        .success,
    ).toBe(false);
    expect(
      ValidationGateResultSchema.safeParse({
        ...base,
        status: "NOT_APPLICABLE",
      }).success,
    ).toBe(false);
  });

  it("enforces strict structured specialist findings", () => {
    expect(
      QAFindingSchema.safeParse({
        schema_version: "1",
        finding_id: "QA-1",
        severity: "HIGH",
        acceptance_criterion: "AC-1",
        evidence: ["EV-1"],
        expected_owner: "backend-engineer",
        blocking: true,
        message: "Unexpected 200 response",
      }).success,
    ).toBe(true);
    expect(
      SecurityFindingSchema.safeParse({
        schema_version: "1",
        finding_id: "SEC-1",
        severity: "CRITICAL",
        category: "AUTHORIZATION",
        affected_files: ["src/auth.ts"],
        evidence: ["EV-2"],
        expected_owner: "backend-engineer",
        blocking: true,
        recommendation: "Enforce tenant membership",
      }).success,
    ).toBe(true);
    expect(
      AccessibilityFindingSchema.safeParse({
        schema_version: "1",
        finding_id: "A11Y-1",
        severity: "MEDIUM",
        category: "KEYBOARD",
        affected_files: ["src/dialog.tsx"],
        evidence: ["EV-3"],
        expected_owner: "frontend-engineer",
        blocking: true,
        message: "Focus escapes dialog",
      }).success,
    ).toBe(true);
    expect(
      SecurityFindingSchema.safeParse({
        schema_version: "1",
        finding_id: "SEC-2",
        severity: "HIGH",
        category: "INPUT",
        affected_files: [],
        evidence: [],
        expected_owner: "security-auditor",
        blocking: true,
        recommendation: "patch it",
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("limits reviewer outcomes and requires findings for requested changes", () => {
    expect(
      ReviewerResultSchema.safeParse({
        schema_version: "1",
        candidate_commit: sha,
        outcome: "APPROVED",
        findings: [],
        completed_at: at,
      }).success,
    ).toBe(true);
    expect(
      ReviewerResultSchema.safeParse({
        schema_version: "1",
        candidate_commit: sha,
        outcome: "CHANGES_REQUESTED",
        findings: [],
        completed_at: at,
      }).success,
    ).toBe(false);
    expect(
      ReviewerResultSchema.safeParse({
        schema_version: "1",
        candidate_commit: sha,
        outcome: "COMMENTED",
        findings: [],
        completed_at: at,
      }).success,
    ).toBe(false);
  });
});

describe("deterministic gate planning", () => {
  it("requires UI validation and records explicit non-applicability", () => {
    const plan = planValidationGates({
      task_type: "FEATURE",
      risk: "MEDIUM",
      changed_domains: ["ui"],
      e2e_supported: false,
      responsive_viewports: ["desktop", "tablet", "mobile"],
      security_relevant: false,
    });
    expect(plan.required).toEqual([
      "QA",
      "ACCESSIBILITY",
      "CODE_REVIEW",
      "RESPONSIVE",
      "EVIDENCE",
    ]);
    expect(plan.applicability.find((item) => item.gate === "E2E")).toEqual({
      gate: "E2E",
      applicable: false,
      reason: "E2E tooling is unavailable or inappropriate",
    });
  });

  it("adds security deterministically for auth and high-risk work", () => {
    const auth = planValidationGates({
      task_type: "FEATURE",
      risk: "MEDIUM",
      changed_domains: ["auth", "backend"],
      e2e_supported: true,
      responsive_viewports: [],
      security_relevant: false,
    });
    const high = planValidationGates({
      task_type: "FEATURE",
      risk: "HIGH",
      changed_domains: ["backend"],
      e2e_supported: false,
      responsive_viewports: [],
      security_relevant: false,
    });
    expect(auth.required).toContain("SECURITY");
    expect(high.required).toContain("SECURITY");
  });
});

describe("acceptance proof completeness", () => {
  it("requires one current-candidate PASS proof and valid evidence per criterion", () => {
    const proof = AcceptanceProofSchema.parse({
      schema_version: "1",
      acceptance_criterion: "AC-1",
      required: true,
      status: "PASS",
      candidate_commit: sha,
      verified_by: ["QA"],
      evidence_refs: ["EV-1"],
      reason: null,
    });
    expect(
      evaluateAcceptanceCompleteness(["AC-1"], [proof], sha, new Set(["EV-1"])),
    ).toEqual({ complete: true, failures: [] });
    expect(
      evaluateAcceptanceCompleteness(
        ["AC-1", "AC-2"],
        [proof],
        sha,
        new Set(["EV-1"]),
      ),
    ).toEqual({ complete: false, failures: ["MISSING_ACCEPTANCE_PROOF:AC-2"] });
    expect(
      evaluateAcceptanceCompleteness(
        ["AC-1"],
        [{ ...proof, candidate_commit: nextSha }],
        sha,
        new Set(["EV-1"]),
      ).failures,
    ).toContain("STALE_ACCEPTANCE_PROOF:AC-1");
  });
});

describe("candidate-bound evidence manifest", () => {
  const manifest = {
    schema_version: "1" as const,
    task_id: "MF-30",
    candidate_commit: sha,
    generated_at: at,
    acceptance_criteria: [
      {
        schema_version: "1" as const,
        acceptance_criterion: "AC-1",
        required: true,
        status: "PASS" as const,
        candidate_commit: sha,
        verified_by: ["QA" as const],
        evidence_refs: ["EV-1"],
        reason: null,
      },
    ],
    gate_results: [
      {
        schema_version: "1" as const,
        gate: "QA" as const,
        status: "PASS" as const,
        candidate_commit: sha,
        evidence_refs: ["EV-1"],
        finding_ids: [],
        reason: null,
        completed_at: at,
      },
    ],
    artifacts: [
      {
        id: "EV-1",
        kind: "SCREENSHOT" as const,
        path: ".forge/artifacts/MF-30/screenshots/home.png",
        sha256: "c".repeat(64),
        candidate_commit: sha,
        producing_gate: "QA" as const,
        tool: "playwright",
        acceptance_ids: ["AC-1"],
        metadata: { viewport: { name: "mobile", width: 375, height: 812 } },
      },
      {
        id: "EV-DOC",
        kind: "DOCUMENTATION" as const,
        path: ".forge/artifacts/MF-30/SUMMARY.md",
        sha256: "e".repeat(64),
        candidate_commit: sha,
        producing_gate: "EVIDENCE" as const,
        tool: "forge",
        acceptance_ids: [],
        metadata: {},
      },
    ],
    documentation: [{ name: "SUMMARY.md" as const, artifact_id: "EV-DOC" }],
    known_limitations: [],
  };

  it("validates media metadata and all manifest references", () => {
    expect(EvidenceManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      evaluateEvidenceManifest(manifest, sha, {
        "EV-1": "c".repeat(64),
        "EV-DOC": "e".repeat(64),
      }),
    ).toEqual({ valid: true, stale: false, failures: [] });
  });

  it("invalidates proof after candidate change or digest mismatch", () => {
    const stale = evaluateEvidenceManifest(manifest, nextSha, {
      "EV-1": "c".repeat(64),
      "EV-DOC": "e".repeat(64),
    });
    expect(stale.valid).toBe(false);
    expect(stale.stale).toBe(true);
    expect(stale.failures).toContain("STALE_MANIFEST");
    expect(stale.failures).toContain("STALE_ARTIFACT:EV-1");
    expect(stale.failures).toContain("STALE_GATE:QA");
    expect(stale.failures).toContain("STALE_ACCEPTANCE_PROOF:AC-1");
    expect(
      evaluateEvidenceManifest(manifest, sha, {
        "EV-1": "d".repeat(64),
        "EV-DOC": "e".repeat(64),
      }).failures,
    ).toContain("DIGEST_MISMATCH:EV-1");
  });

  it("rejects dangling evidence references and fake video metadata", () => {
    expect(
      EvidenceManifestSchema.safeParse({
        ...manifest,
        gate_results: [
          { ...manifest.gate_results[0], evidence_refs: ["MISSING"] },
        ],
      }).success,
    ).toBe(false);
    expect(
      EvidenceManifestSchema.safeParse({
        ...manifest,
        artifacts: [
          {
            ...manifest.artifacts[0],
            kind: "VIDEO",
            metadata: { format: "mp4", segments: [] },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
