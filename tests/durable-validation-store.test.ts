import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DurableValidationStore } from "../packages/execution/src/durable-validation-store.js";
import { ValidationOrchestrator } from "../packages/execution/src/validation-orchestrator.js";
import type { ValidatorDispatch } from "../packages/execution/src/validation-orchestrator.js";

it("resumes validation from canonical disk state without rerunning completed gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-validation-state-"));
  const request = {
    task_id: "MF-VALIDATE",
    candidate_sha: "a".repeat(40),
    domains: ["backend"] as const,
    risk: "LOW" as const,
    policy: {},
    acceptance_criteria: [{ id: "AC-1", text: "API succeeds" }],
  };
  const dispatched: string[] = [];
  const dispatcher = {
    dispatch: (record: ValidatorDispatch) => {
      dispatched.push(record.gate);
      return Promise.resolve({
        gate: record.gate,
        status: "PASS" as const,
        candidate_sha: request.candidate_sha,
        evidence: [
          {
            id: `${record.gate}-proof`,
            acceptance_ids: ["AC-1"],
            reference: `${record.gate}.json`,
            digest: "b".repeat(64),
            candidate_sha: request.candidate_sha,
            producing_gate: record.gate,
          },
        ],
        findings: [],
        changed_paths: [],
        ...(record.gate === "CODE_REVIEW"
          ? { review_decision: "APPROVED" as const }
          : {}),
      });
    },
  };
  const unchangedCandidate = { assertCurrent: () => Promise.resolve() };
  const allowBoundary = { assertAllowed: () => Promise.resolve() };
  const validEvidence = { assertValid: () => Promise.resolve() };
  const noChanges = {
    begin: () => Promise.resolve("baseline"),
    collect: () =>
      Promise.resolve({ paths: [], candidate_sha: request.candidate_sha }),
    reject: () => Promise.resolve(),
    accept: () => Promise.resolve(request.candidate_sha),
  };
  await new ValidationOrchestrator(
    new DurableValidationStore(root),
    dispatcher,
    () => "2026-08-11T00:00:00.000Z",
    unchangedCandidate,
    allowBoundary,
    validEvidence,
    noChanges,
  ).start(request);
  await new ValidationOrchestrator(
    new DurableValidationStore(root),
    dispatcher,
    () => "2026-08-11T00:00:01.000Z",
    unchangedCandidate,
    allowBoundary,
    validEvidence,
    noChanges,
  ).runNext(request.task_id);
  await new ValidationOrchestrator(
    new DurableValidationStore(root),
    dispatcher,
    () => "2026-08-11T00:00:02.000Z",
    unchangedCandidate,
    allowBoundary,
    validEvidence,
    noChanges,
  ).runNext(request.task_id);
  expect(dispatched).toEqual(["QA", "CODE_REVIEW"]);
  const persisted = await new DurableValidationStore(root).load(
    request.task_id,
  );
  expect(persisted?.gates.find((gate) => gate.gate === "QA")?.status).toBe(
    "PASS",
  );
  expect(persisted?.events.map((event) => event.type)).toContain("GATE_PASSED");
});

it("initializes validation state atomically in a phase-specific namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-validation-race-"));
  const request = {
    task_id: "MF-RACE",
    candidate_sha: "d".repeat(40),
    domains: ["backend"] as const,
    risk: "LOW" as const,
    policy: {},
    acceptance_criteria: [{ id: "AC-1", text: "Race is prevented" }],
  };
  const dependencies = () =>
    new ValidationOrchestrator(
      new DurableValidationStore(root),
      { dispatch: () => Promise.reject(new Error("not dispatched")) },
      () => "2026-08-11T00:00:00.000Z",
      { assertCurrent: () => Promise.resolve() },
      { assertAllowed: () => Promise.resolve() },
      { assertValid: () => Promise.resolve() },
      {
        begin: () => Promise.resolve("baseline"),
        collect: () =>
          Promise.resolve({ paths: [], candidate_sha: request.candidate_sha }),
        reject: () => Promise.resolve(),
        accept: () => Promise.resolve(request.candidate_sha),
      },
    );
  const outcomes = await Promise.allSettled([
    dependencies().start(request),
    dependencies().start(request),
  ]);
  expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
  await expect(
    access(join(root, ".forge", "state", "validation", "MF-RACE.json")),
  ).resolves.toBeUndefined();
  await expect(
    access(join(root, ".forge", "state", "MF-RACE.json")),
  ).rejects.toThrow();
});
