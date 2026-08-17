import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DocumentationStateSchema,
  EvidenceStore,
  EvidenceStoreError,
} from "../packages/adapters/src/evidence-store.js";
import { StoredEvidenceVerifier } from "../packages/adapters/src/stored-evidence-verifier.js";

async function repository(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-evidence-"));
}

describe("EvidenceStore", () => {
  it("writes candidate-bound binary and text artifacts with SHA-256 metadata", async () => {
    const root = await repository();
    const store = new EvidenceStore(root);
    const binary = await store.writeArtifact({
      task_id: "TASK-12",
      candidate_sha: "abc123",
      relative_path: "screenshots/home.png",
      content: Buffer.from([0, 1, 2, 255]),
      kind: "screenshot",
      producing_gate: "QA",
      tool: "playwright",
      acceptance_ids: ["AC-1"],
      privacy_reviewed: true,
    });
    const report = await store.writeArtifact({
      task_id: "TASK-12",
      candidate_sha: "abc123",
      relative_path: "reports/qa.txt",
      content: "passed\n",
      kind: "report",
      producing_gate: "QA",
      tool: "vitest",
      acceptance_ids: ["AC-1"],
    });

    expect(binary.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(binary.byte_length).toBe(4);
    expect(binary.location).toBe(
      ".forge/artifacts/TASK-12/screenshots/home.png",
    );
    expect(report.byte_length).toBe(7);
    expect(
      await readFile(join(root, binary.location.replaceAll("/", join("/")))),
    ).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await store.verifyArtifact(binary, "abc123")).toEqual({
      valid: true,
      stale: false,
      reason: null,
    });
    await expect(
      store.verifyReference("TASK-12", report.location, report.sha256),
    ).resolves.toBe(true);
    await expect(
      store.verifyReference("TASK-12", report.location, "0".repeat(64)),
    ).resolves.toBe(false);
    await expect(
      store.verifyReference(
        "TASK-12",
        ".forge/artifacts/OTHER/report.txt",
        report.sha256,
      ),
    ).resolves.toBe(false);
    const verifier = new StoredEvidenceVerifier(root);
    await expect(
      verifier.assertValid("TASK-12", "abc123", [
        {
          id: "report",
          acceptance_ids: ["AC-1"],
          reference: report.location,
          digest: report.sha256,
          candidate_sha: "abc123",
          producing_gate: "QA",
        },
      ]),
    ).resolves.toBeUndefined();
    await expect(
      verifier.assertValid("TASK-12", "abc123", [
        {
          id: "tampered",
          acceptance_ids: ["AC-1"],
          reference: report.location,
          digest: "0".repeat(64),
          candidate_sha: "abc123",
          producing_gate: "QA",
        },
      ]),
    ).rejects.toThrow("VALIDATION_EVIDENCE_MISSING_OR_TAMPERED");
    await expect(
      verifier.assertValid("TASK-12", "different-candidate", [
        {
          id: "stale",
          acceptance_ids: ["AC-1"],
          reference: report.location,
          digest: report.sha256,
          candidate_sha: "different-candidate",
          producing_gate: "QA",
        },
      ]),
    ).rejects.toThrow("VALIDATION_EVIDENCE_MISSING_OR_TAMPERED");
  });

  it.each([
    ["../escape.txt"],
    ["/absolute.txt"],
    ["reports/../../escape.txt"],
    ["reports//bad.txt"],
    ["reports/./bad.txt"],
  ])("rejects unsafe artifact path %s", async (relative_path) => {
    const store = new EvidenceStore(await repository());
    await expect(
      store.writeArtifact({
        task_id: "TASK-1",
        candidate_sha: "abc",
        relative_path,
        content: "bad",
        kind: "report",
        producing_gate: "QA",
        tool: "test",
        acceptance_ids: [],
      }),
    ).rejects.toBeInstanceOf(EvidenceStoreError);
  });

  it.each(["../task", "a/b", ".", "..", " task"])(
    "rejects unsafe task ID %s",
    async (task_id) => {
      const store = new EvidenceStore(await repository());
      await expect(
        store.writeArtifact({
          task_id,
          candidate_sha: "abc",
          relative_path: "reports/result.txt",
          content: "bad",
          kind: "report",
          producing_gate: "QA",
          tool: "test",
          acceptance_ids: [],
        }),
      ).rejects.toBeInstanceOf(EvidenceStoreError);
    },
  );

  it("rejects unreviewed media and secret-like text before persistence", async () => {
    const store = new EvidenceStore(await repository());
    await expect(
      store.writeArtifact({
        task_id: "TASK-PRIVACY",
        candidate_sha: "abc",
        relative_path: "screenshots/page.png",
        content: Buffer.from([1, 2, 3]),
        kind: "screenshot",
        producing_gate: "RESPONSIVE",
        tool: "playwright",
        acceptance_ids: ["AC-1"],
      }),
    ).rejects.toThrow("privacy review");
    await expect(
      store.writeArtifact({
        task_id: "TASK-PRIVACY",
        candidate_sha: "abc",
        relative_path: "reports/log.txt",
        content: "password=do-not-store",
        kind: "report",
        producing_gate: "SECURITY",
        tool: "scanner",
        acceptance_ids: [],
      }),
    ).rejects.toThrow("must be redacted");
  });

  it("refuses symlinks in the canonical artifact path", async () => {
    const root = await repository();
    const outside = await repository();
    await mkdir(join(root, ".forge"));
    await symlink(outside, join(root, ".forge", "artifacts"));
    const store = new EvidenceStore(root);

    await expect(
      store.writeArtifact({
        task_id: "TASK-1",
        candidate_sha: "abc",
        relative_path: "reports/result.txt",
        content: "bad",
        kind: "report",
        producing_gate: "QA",
        tool: "test",
        acceptance_ids: [],
      }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("detects digest tampering and candidate staleness", async () => {
    const root = await repository();
    const store = new EvidenceStore(root);
    const metadata = await store.writeArtifact({
      task_id: "TASK-1",
      candidate_sha: "old",
      relative_path: "videos/flow.webm",
      content: "video",
      kind: "video",
      producing_gate: "E2E",
      tool: "playwright",
      acceptance_ids: ["AC-2"],
      privacy_reviewed: true,
    });

    expect(await store.verifyArtifact(metadata, "new")).toEqual({
      valid: false,
      stale: true,
      reason: "candidate-commit-changed",
    });
    await writeFile(join(root, metadata.location), "tampered");
    expect(await store.verifyArtifact(metadata, "old")).toEqual({
      valid: false,
      stale: false,
      reason: "digest-mismatch",
    });
  });

  it("generates the four documents only from schema-validated execution state", async () => {
    const root = await repository();
    const store = new EvidenceStore(root);
    const state = DocumentationStateSchema.parse({
      task_id: "TASK-9",
      candidate_sha: "deadbeef",
      objective: "Prove the checkout flow",
      outcome: "All required gates passed",
      risk: "MEDIUM",
      affected_domains: ["frontend", "backend"],
      known_limitations: ["Video remains WebM"],
      architectural_impact: ["Added a validation boundary"],
      changes: {
        frontend: ["Added checkout confirmation"],
        backend: ["Added confirmation endpoint"],
        database: [],
        mobile: [],
      },
      important_contracts: ["Confirmation response v1"],
      test_suites: [{ name: "unit", status: "PASS", detail: "12 passed" }],
      acceptance_results: [
        { id: "AC-1", status: "PASS", evidence: ["shot-1"] },
      ],
      gate_results: [
        { gate: "QA", status: "PASS", detail: "No findings" },
        {
          gate: "SECURITY",
          status: "NOT_APPLICABLE",
          detail: "No auth changes",
        },
      ],
      known_gaps: [],
      files_changed: ["packages/ui/checkout.ts"],
      migrations: [],
      dependencies: [],
      configuration_changes: [],
      environment_considerations: ["Node 22"],
    });

    const documents = await store.generateDocumentation(state);
    expect(documents.map((item) => item.location)).toEqual([
      ".forge/artifacts/TASK-9/SUMMARY.md",
      ".forge/artifacts/TASK-9/IMPLEMENTATION.md",
      ".forge/artifacts/TASK-9/TESTING.md",
      ".forge/artifacts/TASK-9/CHANGES.md",
    ]);
    const summary = await readFile(join(root, documents[0]!.location), "utf8");
    expect(summary).toContain("Prove the checkout flow");
    expect(summary).toContain("Video remains WebM");
    expect(summary).not.toContain("undefined");

    await expect(
      store.generateDocumentation({ ...state, outcome: undefined }),
    ).rejects.toThrow();
  });
});
