import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitCandidateVerifier } from "../packages/adapters/src/git-candidate-verifier.js";
import { GitValidationChangeMonitor } from "../packages/adapters/src/git-validation-change-monitor.js";
import { OwnershipValidationBoundary } from "../packages/adapters/src/validation-boundary-verifier.js";
import { DurableValidationStore } from "../packages/execution/src/durable-validation-store.js";
import { ValidationOrchestrator } from "../packages/execution/src/validation-orchestrator.js";

const execFile = promisify(execFileCallback);

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "forge-validation-diff-"));
  await execFile("git", ["init", "-b", "main", root]);
  await execFile("git", ["config", "user.email", "forge@example.test"], {
    cwd: root,
  });
  await execFile("git", ["config", "user.name", "Forge Tests"], { cwd: root });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.ts"), "export const safe = true;\n");
  await writeFile(
    join(root, ".gitignore"),
    ".forge/\ntest-results/\nplaywright-report/\n*.env\n",
  );
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-m", "candidate"], { cwd: root });
  const candidate = (
    await execFile("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    })
  ).stdout.trim();
  return { root, candidate };
}

const evidenceVerifier = { assertValid: () => Promise.resolve() };

describe("real validation change attribution", () => {
  it("blocks and restores an unreported read-only validator modification", async () => {
    const { root, candidate } = await repository();
    const store = new DurableValidationStore(root);
    const orchestrator = new ValidationOrchestrator(
      store,
      {
        dispatch: async (record) => {
          await writeFile(
            join(root, "src", "app.ts"),
            "export const safe = false;\n",
          );
          return {
            gate: record.gate,
            status: "PASS",
            candidate_sha: candidate,
            evidence: [
              {
                id: "security-proof",
                acceptance_ids: ["AC-1"],
                reference: ".forge/artifacts/MF-SEC/security.json",
                digest: "a".repeat(64),
                candidate_sha: candidate,
                producing_gate: "SECURITY",
              },
            ],
            findings: [],
            changed_paths: [],
          };
        },
      },
      () => "2026-08-11T00:00:00.000Z",
      new GitCandidateVerifier(root),
      new OwnershipValidationBoundary([
        { pattern: "src/**", owner: "frontend-engineer", effect: "allow" },
      ]),
      evidenceVerifier,
      new GitValidationChangeMonitor(root),
    );
    await orchestrator.start({
      task_id: "MF-SEC",
      candidate_sha: candidate,
      domains: ["backend"],
      risk: "HIGH",
      policy: { security_relevant: true },
      acceptance_criteria: [{ id: "AC-1", text: "Remains secure" }],
    });
    await expect(orchestrator.runGate("MF-SEC", "SECURITY")).rejects.toThrow(
      "VALIDATOR_CHANGE_REPORT_MISMATCH",
    );
    await expect(readFile(join(root, "src", "app.ts"), "utf8")).resolves.toBe(
      "export const safe = true;\n",
    );
    expect((await store.load("MF-SEC"))?.proof_status).toBe("BLOCKED");
  });

  it("accepts an owned QA test commit and invalidates proof for the new candidate", async () => {
    const { root, candidate } = await repository();
    const orchestrator = new ValidationOrchestrator(
      new DurableValidationStore(root),
      {
        dispatch: async () => {
          await mkdir(join(root, "tests"), { recursive: true });
          await writeFile(join(root, "tests", "flow.test.ts"), "export {};\n");
          return {
            gate: "QA",
            status: "PASS",
            candidate_sha: candidate,
            evidence: [
              {
                id: "qa-proof",
                acceptance_ids: ["AC-1"],
                reference: ".forge/artifacts/MF-QA/qa.json",
                digest: "b".repeat(64),
                candidate_sha: candidate,
                producing_gate: "QA",
              },
            ],
            findings: [],
            changed_paths: ["tests/flow.test.ts"],
          };
        },
      },
      () => "2026-08-11T00:00:00.000Z",
      new GitCandidateVerifier(root),
      new OwnershipValidationBoundary([
        { pattern: "tests/**", owner: "qa-engineer", effect: "allow" },
      ]),
      evidenceVerifier,
      new GitValidationChangeMonitor(root),
    );
    await orchestrator.start({
      task_id: "MF-QA",
      candidate_sha: candidate,
      domains: ["backend"],
      risk: "LOW",
      policy: {},
      acceptance_criteria: [{ id: "AC-1", text: "Flow passes" }],
    });
    await expect(orchestrator.runGate("MF-QA", "QA")).resolves.toBe(
      "PROGRESSED",
    );
    const state = await new DurableValidationStore(root).load("MF-QA");
    expect(state?.candidate_sha).not.toBe(candidate);
    expect(state?.gates.find((gate) => gate.gate === "QA")).toMatchObject({
      status: "FAIL",
      reason: "STALE_CANDIDATE",
    });
  });

  it("detects and removes ignored writes outside an empty read-only grant", async () => {
    const { root, candidate } = await repository();
    const orchestrator = new ValidationOrchestrator(
      new DurableValidationStore(root),
      {
        dispatch: async () => {
          await writeFile(join(root, "leak.env"), "TOKEN=not-allowed\n");
          return {
            gate: "CODE_REVIEW",
            status: "PASS",
            candidate_sha: candidate,
            evidence: [
              {
                id: "review-proof",
                acceptance_ids: ["AC-1"],
                reference: ".forge/artifacts/MF-IGNORED/review.json",
                digest: "c".repeat(64),
                candidate_sha: candidate,
                producing_gate: "CODE_REVIEW",
              },
            ],
            findings: [],
            changed_paths: [],
            review_decision: "APPROVED",
          };
        },
      },
      () => "2026-08-11T00:00:00.000Z",
      new GitCandidateVerifier(root),
      new OwnershipValidationBoundary([]),
      evidenceVerifier,
      new GitValidationChangeMonitor(root),
    );
    await orchestrator.start({
      task_id: "MF-IGNORED",
      candidate_sha: candidate,
      domains: ["backend"],
      risk: "LOW",
      policy: {},
      acceptance_criteria: [{ id: "AC-1", text: "Review passes" }],
    });
    await expect(
      orchestrator.runGate("MF-IGNORED", "CODE_REVIEW"),
    ).rejects.toThrow("Ignored implementation/config changes are prohibited");
    await expect(access(join(root, "leak.env"))).rejects.toThrow();
  });
});
