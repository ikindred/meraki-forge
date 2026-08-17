import { describe, expect, it } from "vitest";
import {
  ValidationOrchestrator,
  planValidationGates,
  type ValidationState,
  type ValidationStore,
  type ValidatorDispatch,
  type ValidatorDispatcher,
  type ValidatorResult,
} from "../packages/execution/src/validation-orchestrator.js";

class MemoryStore implements ValidationStore {
  state?: ValidationState;
  load() {
    return Promise.resolve(this.state);
  }
  save(state: ValidationState, revision: number | null) {
    expect(this.state?.revision ?? null).toBe(revision);
    this.state = state;
    return Promise.resolve();
  }
}

const base = {
  task_id: "TASK-3",
  candidate_sha: "a".repeat(40),
  domains: ["frontend"] as const,
  risk: "MEDIUM" as const,
  policy: { e2e_available: true, require_e2e: true },
  acceptance_criteria: [{ id: "AC-1", text: "User can save" }],
};
const unchangedCandidate = { assertCurrent: () => Promise.resolve() };
const allowBoundary = { assertAllowed: () => Promise.resolve() };
const validEvidence = { assertValid: () => Promise.resolve() };
const changeMonitor = (
  candidate = base.candidate_sha,
  paths: readonly string[] = [],
) => ({
  begin: () => Promise.resolve("baseline"),
  collect: () => Promise.resolve({ paths, candidate_sha: candidate }),
  reject: () => Promise.resolve(),
  accept: () => Promise.resolve(candidate),
});

function result(
  gate: ValidatorResult["gate"],
  overrides: Partial<ValidatorResult> = {},
): ValidatorResult {
  return {
    gate,
    status: "PASS",
    candidate_sha: base.candidate_sha,
    evidence: [
      {
        id: `${gate}-proof`,
        acceptance_ids: ["AC-1"],
        reference: `report/${gate}`,
        digest: "b".repeat(64),
        candidate_sha: base.candidate_sha,
        producing_gate: gate,
      },
    ],
    findings: [],
    changed_paths: [],
    ...(gate === "CODE_REVIEW" ? { review_decision: "APPROVED" as const } : {}),
    ...overrides,
  };
}

describe("validation planning", () => {
  it("computes UI gates and explicit non-applicable statuses", () => {
    const plan = planValidationGates(base);
    expect(plan.filter((g) => g.required).map((g) => g.gate)).toEqual([
      "QA",
      "ACCESSIBILITY",
      "CODE_REVIEW",
      "E2E",
      "RESPONSIVE",
      "EVIDENCE",
    ]);
    expect(plan.find((g) => g.gate === "SECURITY")).toMatchObject({
      required: false,
      status: "NOT_APPLICABLE",
    });
  });

  it("requires security for auth/high-risk work and explains unavailable E2E", () => {
    const plan = planValidationGates({
      ...base,
      domains: ["backend"],
      risk: "HIGH",
      policy: {
        e2e_available: false,
        require_e2e: true,
        security_relevant: true,
      },
    });
    expect(plan.find((g) => g.gate === "SECURITY")?.required).toBe(true);
    expect(plan.find((g) => g.gate === "E2E")).toMatchObject({
      status: "NOT_APPLICABLE",
      reason: "E2E tooling is unavailable",
    });
  });
});

describe("validation orchestration", () => {
  it("persists CAS state, dispatches structured read-only review, and proves criteria deterministically", async () => {
    const store = new MemoryStore();
    const records: ValidatorDispatch[] = [];
    const dispatcher: ValidatorDispatcher = {
      dispatch: (record) => {
        records.push(record);
        return Promise.resolve(result(record.gate));
      },
    };
    const orchestrator = new ValidationOrchestrator(
      store,
      dispatcher,
      () => "2026-08-11T00:00:00.000Z",
      unchangedCandidate,
      allowBoundary,
      validEvidence,
      changeMonitor(),
    );
    await orchestrator.start(base);
    for (let index = 0; index < 6; index++)
      await orchestrator.runNext("TASK-3");
    expect(store.state?.proof_status).toBe("COMPLETE");
    expect(store.state?.acceptance_results).toEqual([
      {
        acceptance_id: "AC-1",
        status: "PASS",
        verified_by: ["QA", "E2E"],
        evidence_ids: ["QA-proof", "E2E-proof"],
      },
    ]);
    expect(records.find((entry) => entry.gate === "CODE_REVIEW")).toMatchObject(
      { persona_id: "code-reviewer", read_only: true, allowed_write_paths: [] },
    );
  });

  it.each([
    ["SECURITY", "security-auditor"],
    ["ACCESSIBILITY", "accessibility-auditor"],
    ["CODE_REVIEW", "code-reviewer"],
  ] as const)("rejects production patches from %s", async (gate, _persona) => {
    const store = new MemoryStore();
    const orchestrator = new ValidationOrchestrator(
      store,
      {
        dispatch: (record) => {
          expect(record.persona_id).toBe(_persona);
          return Promise.resolve(
            result(gate, { changed_paths: ["src/hack.ts"] }),
          );
        },
      },
      () => "2026-08-11T00:00:00.000Z",
      unchangedCandidate,
      allowBoundary,
      validEvidence,
      changeMonitor(base.candidate_sha, ["src/hack.ts"]),
    );
    await orchestrator.start({
      ...base,
      domains: gate === "SECURITY" ? ["backend"] : ["frontend"],
      risk: gate === "SECURITY" ? "HIGH" : "MEDIUM",
      policy: { security_relevant: gate === "SECURITY", force_gates: [gate] },
    });
    await expect(orchestrator.runGate("TASK-3", gate)).rejects.toThrow(
      "VALIDATOR_WRITE_VIOLATION",
    );
  });

  it("allows QA writes only in test and artifact namespaces", async () => {
    const store = new MemoryStore();
    const orchestrator = new ValidationOrchestrator(
      store,
      {
        dispatch: () =>
          Promise.resolve(
            result("QA", {
              changed_paths: ["tests/new.test.ts", "test-results/qa.json"],
            }),
          ),
      },
      () => "2026-08-11T00:00:00.000Z",
      unchangedCandidate,
      allowBoundary,
      validEvidence,
      changeMonitor(base.candidate_sha, [
        "tests/new.test.ts",
        "test-results/qa.json",
      ]),
    );
    await orchestrator.start(base);
    await expect(orchestrator.runGate("TASK-3", "QA")).resolves.toBe(
      "PROGRESSED",
    );
  });

  it("routes blocking findings to repair, enforces owner and the three-attempt ceiling", async () => {
    const store = new MemoryStore();
    const failing = result("QA", {
      status: "FAIL",
      evidence: [],
      findings: [
        {
          finding_id: "F-1",
          severity: "HIGH",
          acceptance_criterion: "AC-1",
          evidence: ["qa.log"],
          expected_owner: "frontend-engineer",
          blocking: true,
          message: "Save fails",
          affected_paths: ["src/save.ts"],
        },
      ],
    });
    const orchestrator = new ValidationOrchestrator(
      store,
      { dispatch: () => Promise.resolve(failing) },
      () => "2026-08-11T00:00:00.000Z",
      unchangedCandidate,
      allowBoundary,
      validEvidence,
      changeMonitor(),
    );
    await orchestrator.start(base);
    expect(await orchestrator.runGate("TASK-3", "QA")).toBe("REPAIR_REQUIRED");
    expect(store.state?.repair).toMatchObject({
      attempts: 0,
      status: "REPAIRING",
      owners: ["frontend-engineer"],
    });
    for (let attempt = 0; attempt < 3; attempt++)
      await orchestrator.recordRepairOutcome("TASK-3", {
        owner: "frontend-engineer",
        successful: false,
        result: "still failing",
        remaining_finding_id: "F-1",
      });
    expect(store.state?.repair.status).toBe("BLOCKED");
    await expect(
      orchestrator.recordRepairOutcome("TASK-3", {
        owner: "frontend-engineer",
        successful: false,
        result: "again",
        remaining_finding_id: "F-1",
      }),
    ).rejects.toThrow("Repair attempt ceiling reached");
  });

  it("invalidates every required result and proof when the candidate changes", async () => {
    const store = new MemoryStore();
    let monitoredCandidate = base.candidate_sha;
    const dynamicMonitor = {
      begin: () => Promise.resolve("baseline"),
      collect: () =>
        Promise.resolve({ paths: [], candidate_sha: monitoredCandidate }),
      reject: () => Promise.resolve(),
      accept: () => Promise.resolve(monitoredCandidate),
    };
    const orchestrator = new ValidationOrchestrator(
      store,
      {
        dispatch: (record) =>
          Promise.resolve({
            ...result(record.gate),
            candidate_sha: record.candidate_sha,
            evidence: result(record.gate).evidence.map((item) => ({
              ...item,
              candidate_sha: record.candidate_sha,
            })),
          }),
      },
      () => "2026-08-11T00:00:00.000Z",
      unchangedCandidate,
      allowBoundary,
      validEvidence,
      dynamicMonitor,
    );
    await orchestrator.start(base);
    await orchestrator.runGate("TASK-3", "QA");
    monitoredCandidate = "c".repeat(40);
    await orchestrator.bindCandidate("TASK-3", "c".repeat(40));
    expect(store.state?.gates.find((g) => g.gate === "QA")).toMatchObject({
      status: "FAIL",
      evidence_ids: [],
      reason: "STALE_CANDIDATE",
    });
    expect(store.state?.acceptance_results[0]?.status).toBe("FAIL");
    expect(store.state?.proof_status).toBe("INCOMPLETE");
    expect(await orchestrator.runNext("TASK-3")).toBe("PROGRESSED");
    expect(store.state?.gates.find((g) => g.gate === "QA")?.status).toBe(
      "PASS",
    );
  });

  it("rejects stale results and invalid reviewer decisions", async () => {
    const store = new MemoryStore();
    let bad = result("CODE_REVIEW", {
      candidate_sha: "d".repeat(40),
      review_decision: "APPROVED",
    });
    const orchestrator = new ValidationOrchestrator(
      store,
      { dispatch: () => Promise.resolve(bad) },
      () => "2026-08-11T00:00:00.000Z",
      unchangedCandidate,
      allowBoundary,
      validEvidence,
      changeMonitor(),
    );
    await orchestrator.start(base);
    await expect(orchestrator.runGate("TASK-3", "CODE_REVIEW")).rejects.toThrow(
      "STALE_VALIDATION_RESULT",
    );
    expect(store.state?.running_gate).toBeNull();
    expect(store.state?.proof_status).toBe("BLOCKED");
    const reviewStore = new MemoryStore();
    bad = { ...result("CODE_REVIEW"), review_decision: "COMMENTED" as never };
    const reviewOrchestrator = new ValidationOrchestrator(
      reviewStore,
      { dispatch: () => Promise.resolve(bad) },
      () => "2026-08-11T00:00:00.000Z",
      unchangedCandidate,
      allowBoundary,
      validEvidence,
      changeMonitor(),
    );
    await reviewOrchestrator.start(base);
    await expect(
      reviewOrchestrator.runGate("TASK-3", "CODE_REVIEW"),
    ).rejects.toThrow("INVALID_VALIDATOR_RESULT");
  });

  it("rolls back and durably blocks when real change collection fails", async () => {
    const store = new MemoryStore();
    let rejected = 0;
    const orchestrator = new ValidationOrchestrator(
      store,
      { dispatch: () => Promise.resolve(result("QA")) },
      () => "2026-08-11T00:00:00.000Z",
      unchangedCandidate,
      allowBoundary,
      validEvidence,
      {
        begin: () => Promise.resolve("baseline"),
        collect: () => Promise.reject(new Error("symlink escape")),
        reject: () => {
          rejected += 1;
          return Promise.resolve();
        },
        accept: () => Promise.resolve(base.candidate_sha),
      },
    );
    await orchestrator.start(base);
    await expect(orchestrator.runGate("TASK-3", "QA")).rejects.toThrow(
      "symlink escape",
    );
    expect(rejected).toBe(1);
    expect(store.state).toMatchObject({
      running_gate: null,
      proof_status: "BLOCKED",
    });
  });

  it("rejects secret-like validator output before durable persistence", async () => {
    const store = new MemoryStore();
    const unsafe = result("QA", {
      status: "FAIL",
      evidence: [],
      findings: [
        {
          finding_id: "F-SECRET",
          severity: "HIGH",
          acceptance_criterion: "AC-1",
          evidence: ["qa.log"],
          expected_owner: "frontend-engineer",
          blocking: true,
          message: "password=must-not-persist",
          affected_paths: ["src/save.ts"],
        },
      ],
    });
    const orchestrator = new ValidationOrchestrator(
      store,
      { dispatch: () => Promise.resolve(unsafe) },
      () => "2026-08-11T00:00:00.000Z",
      unchangedCandidate,
      allowBoundary,
      validEvidence,
      changeMonitor(),
    );
    await orchestrator.start(base);
    await expect(orchestrator.runGate("TASK-3", "QA")).rejects.toThrow(
      "VALIDATION_CONTENT_REQUIRES_REDACTION",
    );
    expect(JSON.stringify(store.state)).not.toContain("must-not-persist");
  });

  it("does not persist secrets from validator failure diagnostics", async () => {
    const store = new MemoryStore();
    const orchestrator = new ValidationOrchestrator(
      store,
      {
        dispatch: () =>
          Promise.reject(
            new Error("validator stderr: password=must-not-persist"),
          ),
      },
      () => "2026-08-11T00:00:00.000Z",
      unchangedCandidate,
      allowBoundary,
      validEvidence,
      changeMonitor(),
    );
    await orchestrator.start(base);
    await expect(orchestrator.runGate("TASK-3", "QA")).rejects.toThrow(
      "must-not-persist",
    );
    expect(JSON.stringify(store.state)).not.toContain("must-not-persist");
    expect(store.state?.gates.find((gate) => gate.gate === "QA")?.reason).toBe(
      "EXTERNAL_VALIDATION_FAILURE",
    );
  });

  it("does not treat attacker-controlled uppercase diagnostics as safe codes", async () => {
    const store = new MemoryStore();
    const credentialShapedDiagnostic = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const orchestrator = new ValidationOrchestrator(
      store,
      {
        dispatch: () => Promise.reject(new Error(credentialShapedDiagnostic)),
      },
      () => "2026-08-11T00:00:00.000Z",
      unchangedCandidate,
      allowBoundary,
      validEvidence,
      changeMonitor(),
    );
    await orchestrator.start(base);
    await expect(orchestrator.runGate("TASK-3", "QA")).rejects.toThrow(
      credentialShapedDiagnostic,
    );
    expect(JSON.stringify(store.state)).not.toContain(
      credentialShapedDiagnostic,
    );
    expect(store.state?.gates.find((gate) => gate.gate === "QA")?.reason).toBe(
      "EXTERNAL_VALIDATION_FAILURE",
    );
  });
});
