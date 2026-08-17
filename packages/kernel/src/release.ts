import { createHash } from "node:crypto";
import type { TaskContract } from "./contracts.js";
import { EvidenceItemSchema, GateResultSchema } from "./contracts.js";
export interface ReleaseInput {
  readonly task: TaskContract;
  readonly manifest_revision: number;
  readonly candidate_sha: string;
  readonly required_gate_ids: readonly string[];
  readonly required_evidence_kinds: readonly string[];
  readonly gates: readonly unknown[];
  readonly evidence: readonly unknown[];
  readonly ownership_clean: boolean;
  readonly unresolved_findings: number;
  readonly documentation_complete: boolean;
  readonly known_limitations_documented: boolean;
}
export interface ReleaseEligibility {
  readonly eligible: boolean;
  readonly failures: readonly string[];
  readonly proof?: {
    readonly task_id: string;
    readonly manifest_revision: number;
    readonly candidate_sha: string;
    readonly policy_digest: string;
  };
}
export function evaluateRelease(input: ReleaseInput): ReleaseEligibility {
  const failures: string[] = [];
  const gates = input.gates.flatMap((gate) => {
    const parsed = GateResultSchema.safeParse(gate);
    if (!parsed.success) {
      failures.push("INVALID_GATE_RESULT");
      return [];
    }
    return [parsed.data];
  });
  const evidence = input.evidence.flatMap((item) => {
    const parsed = EvidenceItemSchema.safeParse(item);
    if (!parsed.success) {
      failures.push("INVALID_EVIDENCE");
      return [];
    }
    return [parsed.data];
  });
  const gateById = new Map(gates.map((gate) => [gate.id, gate]));
  if (
    input.required_gate_ids.some(
      (id) =>
        gateById.get(id)?.status !== "PASS" ||
        gateById.get(id)?.candidate_sha !== input.candidate_sha,
    )
  )
    failures.push("REQUIRED_GATE_MISSING");
  const evidenceKinds = new Set(
    evidence
      .filter(
        (item) =>
          item.candidate_sha === input.candidate_sha && item.result === "PASS",
      )
      .map((item) => item.kind),
  );
  if (input.required_evidence_kinds.some((kind) => !evidenceKinds.has(kind)))
    failures.push("REQUIRED_EVIDENCE_KIND_MISSING");
  const evidenceIds = new Set(
    evidence
      .filter(
        (item) =>
          item.result === "PASS" && item.candidate_sha === input.candidate_sha,
      )
      .map((item) => item.id),
  );
  if (
    gates.some((gate) => gate.evidence_ids.some((id) => !evidenceIds.has(id)))
  )
    failures.push("GATE_EVIDENCE_REFERENCE_INVALID");
  if (!input.ownership_clean) failures.push("OWNERSHIP_NOT_CLEAN");
  if (
    gates.some(
      (gate) =>
        gate.candidate_sha !== input.candidate_sha || gate.status !== "PASS",
    )
  )
    failures.push("REQUIRED_GATE_NOT_PASSING");
  const covered = new Set(
    evidence
      .filter(
        (item) =>
          item.candidate_sha === input.candidate_sha && item.result === "PASS",
      )
      .flatMap((item) => item.acceptance_ids),
  );
  if (
    input.task.acceptance_criteria.some(
      (criterion) => !covered.has(criterion.id),
    )
  )
    failures.push("ACCEPTANCE_EVIDENCE_INCOMPLETE");
  if (input.unresolved_findings) failures.push("UNRESOLVED_FINDINGS");
  if (!input.documentation_complete || !input.known_limitations_documented)
    failures.push("DOCUMENTATION_INCOMPLETE");
  const unique = [...new Set(failures)];
  return unique.length
    ? Object.freeze({ eligible: false, failures: unique })
    : Object.freeze({
        eligible: true,
        failures: [],
        proof: {
          task_id: input.task.id,
          manifest_revision: input.manifest_revision,
          candidate_sha: input.candidate_sha,
          policy_digest: createHash("sha256")
            .update(
              JSON.stringify({
                task: input.task.id,
                revision: input.manifest_revision,
                sha: input.candidate_sha,
                gates: [...input.required_gate_ids].sort(),
                evidence: [...input.required_evidence_kinds].sort(),
              }),
            )
            .digest("hex"),
        },
      });
}
