import {
  applyRepairResult,
  createRepairState,
  type RepairState,
} from "../../kernel/src/repair.js";
import type { Persona } from "../../kernel/src/contracts.js";
import { PersonaSchema } from "../../kernel/src/contracts.js";
import { z } from "zod";
import { normalizeRepoPath } from "../../kernel/src/ownership.js";

export const VALIDATION_GATES = [
  "QA",
  "SECURITY",
  "ACCESSIBILITY",
  "CODE_REVIEW",
  "E2E",
  "RESPONSIVE",
  "EVIDENCE",
] as const;
export type ValidationGate = (typeof VALIDATION_GATES)[number];
export type ValidationStatus = "PASS" | "FAIL" | "NOT_APPLICABLE";
export type ValidationDomain =
  "frontend" | "backend" | "database" | "mobile" | "infrastructure";
export type ValidationRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ValidationPolicy {
  readonly e2e_available?: boolean | undefined;
  readonly require_e2e?: boolean | undefined;
  readonly security_relevant?: boolean | undefined;
  readonly force_gates?: readonly ValidationGate[] | undefined;
}
export interface ValidationRequest {
  readonly task_id: string;
  readonly candidate_sha: string;
  readonly domains: readonly ValidationDomain[];
  readonly risk: ValidationRisk;
  readonly policy: ValidationPolicy;
  readonly acceptance_criteria: readonly {
    readonly id: string;
    readonly text: string;
  }[];
}
export interface PlannedGate {
  readonly gate: ValidationGate;
  readonly required: boolean;
  readonly status: ValidationStatus;
  readonly reason: string;
}
export interface ValidationFinding {
  readonly finding_id: string;
  readonly severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly acceptance_criterion?: string | undefined;
  readonly category?: string | undefined;
  readonly evidence: readonly string[];
  readonly expected_owner: Persona;
  readonly blocking: boolean;
  readonly message: string;
  readonly affected_paths: readonly string[];
  readonly recommendation?: string | undefined;
}
export interface ValidationEvidence {
  readonly id: string;
  readonly acceptance_ids: readonly string[];
  readonly reference: string;
  readonly digest: string;
  readonly candidate_sha: string;
  readonly producing_gate: ValidationGate;
}
export interface ValidatorResult {
  readonly gate: ValidationGate;
  readonly status: ValidationStatus;
  readonly candidate_sha: string;
  readonly evidence: readonly ValidationEvidence[];
  readonly findings: readonly ValidationFinding[];
  readonly changed_paths: readonly string[];
  readonly reason?: string | undefined;
  readonly review_decision?: "APPROVED" | "CHANGES_REQUESTED" | undefined;
}
const ValidationEvidenceSchema = z
  .object({
    id: z.string().min(1),
    acceptance_ids: z.array(z.string().min(1)),
    reference: z.string().min(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    candidate_sha: z.string().regex(/^[a-f0-9]{40,64}$/),
    producing_gate: z.enum(VALIDATION_GATES),
  })
  .strict();
const ImplementationOwnerSchema = PersonaSchema.refine((persona) =>
  [
    "frontend-engineer",
    "backend-engineer",
    "mobile-engineer",
    "database-architect",
  ].includes(persona),
);
const RepoPathSchema = z.string().refine((path) => {
  try {
    return normalizeRepoPath(path) === path;
  } catch {
    return false;
  }
}, "Path must be normalized and repository-relative");
const ValidationFindingSchema = z
  .object({
    finding_id: z.string().min(1),
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    acceptance_criterion: z.string().optional(),
    category: z.string().optional(),
    evidence: z.array(z.string().min(1)),
    expected_owner: ImplementationOwnerSchema,
    blocking: z.boolean(),
    message: z.string().min(1),
    affected_paths: z.array(RepoPathSchema),
    recommendation: z.string().optional(),
  })
  .strict();
export const ValidatorResultSchema = z
  .object({
    gate: z.enum(VALIDATION_GATES),
    status: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
    candidate_sha: z.string().regex(/^[a-f0-9]{40,64}$/),
    evidence: z.array(ValidationEvidenceSchema),
    findings: z.array(ValidationFindingSchema),
    changed_paths: z.array(RepoPathSchema),
    reason: z.string().min(1).optional(),
    review_decision: z.enum(["APPROVED", "CHANGES_REQUESTED"]).optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      new Set(result.evidence.map((item) => item.id)).size !==
      result.evidence.length
    )
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Evidence IDs must be unique",
      });
    if (
      new Set(result.findings.map((item) => item.finding_id)).size !==
      result.findings.length
    )
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "Finding IDs must be unique",
      });
    if (
      result.status === "PASS" &&
      result.findings.some((finding) => finding.blocking)
    )
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "PASS cannot contain blocking findings",
      });
    if (result.status === "PASS" && result.evidence.length === 0)
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "PASS requires evidence",
      });
    if (result.status === "FAIL" && result.findings.length === 0)
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "FAIL requires structured findings",
      });
    if (
      result.status === "NOT_APPLICABLE" &&
      (!result.reason || result.evidence.length || result.findings.length)
    )
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "NOT_APPLICABLE requires only a reason",
      });
  });

function assertSafePersistedContent(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024)
    throw new Error("VALIDATION_RESULT_TOO_LARGE");
  const sensitive =
    /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-[A-Za-z0-9_-]{12,}|api[_-]?key\s*[:=]|password\s*[:=]|authorization\s*:\s*bearer|\b\d{3}-\d{2}-\d{4}\b|\b(?:\d[ -]*?){13,16}\b)/i;
  if (sensitive.test(serialized))
    throw new Error("VALIDATION_CONTENT_REQUIRES_REDACTION");
}

const SAFE_FAILURE_REASONS = new Set([
  "INVALID_GATE_STATUS",
  "INVALID_REVIEW_DECISION",
  "INVALID_VALIDATION_EVIDENCE",
  "INVALID_VALIDATOR_RESULT",
  "REQUIRED_GATE_NOT_APPLICABLE",
  "REVIEW_STATUS_MISMATCH",
  "STALE_VALIDATION_RESULT",
  "VALIDATION_CONTENT_REQUIRES_REDACTION",
  "VALIDATION_GATE_MISMATCH",
  "VALIDATION_RESULT_TOO_LARGE",
  "VALIDATOR_CHANGE_REPORT_MISMATCH",
  "VALIDATOR_WRITE_VIOLATION",
]);

function stableFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return SAFE_FAILURE_REASONS.has(message)
    ? message
    : "EXTERNAL_VALIDATION_FAILURE";
}
export interface ValidatorDispatch {
  readonly task_id: string;
  readonly candidate_sha: string;
  readonly gate: ValidationGate;
  readonly persona_id: Persona;
  readonly read_only: boolean;
  readonly allowed_write_paths: readonly string[];
  readonly acceptance_criteria: readonly {
    readonly id: string;
    readonly text: string;
  }[];
  readonly expected_result: "STRUCTURED_VALIDATION_RESULT";
}
export interface ValidatorDispatcher {
  dispatch(record: ValidatorDispatch): Promise<ValidatorResult>;
}
export interface GateState extends PlannedGate {
  readonly candidate_sha: string;
  readonly evidence_ids: readonly string[];
  readonly findings: readonly ValidationFinding[];
}
export interface AcceptanceResult {
  readonly acceptance_id: string;
  readonly status: "PASS" | "FAIL";
  readonly verified_by: readonly ValidationGate[];
  readonly evidence_ids: readonly string[];
}
export interface ValidationState {
  readonly schema_version: "1";
  readonly task_id: string;
  readonly revision: number;
  readonly candidate_sha: string;
  readonly domains: readonly ValidationDomain[];
  readonly risk: ValidationRisk;
  readonly policy: ValidationPolicy;
  readonly acceptance_criteria: ValidationRequest["acceptance_criteria"];
  readonly gates: readonly GateState[];
  readonly evidence: readonly ValidationEvidence[];
  readonly acceptance_results: readonly AcceptanceResult[];
  readonly repair: RepairState;
  readonly proof_status: "INCOMPLETE" | "COMPLETE" | "BLOCKED";
  readonly running_gate: ValidationGate | null;
  readonly events: readonly {
    readonly type: string;
    readonly at: string;
    readonly gate?: ValidationGate | undefined;
    readonly candidate_sha: string;
  }[];
  readonly updated_at: string;
}
export interface ValidationStore {
  load(taskId: string): Promise<ValidationState | undefined>;
  save(state: ValidationState, expectedRevision: number | null): Promise<void>;
}
export interface CandidateVerifier {
  assertCurrent(candidateSha: string): Promise<void>;
}
export interface ValidationBoundaryVerifier {
  assertAllowed(
    persona: Persona,
    changedPaths: readonly string[],
    grant: readonly string[],
  ): Promise<void>;
}
export interface ValidationEvidenceVerifier {
  assertValid(
    taskId: string,
    candidateSha: string,
    evidence: readonly ValidationEvidence[],
  ): Promise<void>;
}
export interface ValidationChangeMonitor {
  begin(grant: readonly string[]): Promise<string>;
  collect(baseline: string): Promise<{
    readonly paths: readonly string[];
    readonly candidate_sha: string;
  }>;
  reject(baseline: string): Promise<void>;
  accept(baseline: string, gate: ValidationGate): Promise<string>;
}

const requiredSet = (
  request: ValidationRequest,
): ReadonlySet<ValidationGate> => {
  const required = new Set<ValidationGate>(["QA", "CODE_REVIEW", "EVIDENCE"]);
  const ui = request.domains.some(
    (domain) => domain === "frontend" || domain === "mobile",
  );
  if (ui) {
    required.add("ACCESSIBILITY");
    required.add("RESPONSIVE");
  }
  if (
    request.policy.security_relevant ||
    request.risk === "HIGH" ||
    request.risk === "CRITICAL"
  )
    required.add("SECURITY");
  if (request.policy.require_e2e && request.policy.e2e_available)
    required.add("E2E");
  for (const gate of request.policy.force_gates ?? []) required.add(gate);
  return required;
};

export function planValidationGates(
  request: ValidationRequest,
): readonly PlannedGate[] {
  const required = requiredSet(request);
  return VALIDATION_GATES.map((gate) => {
    if (
      gate === "E2E" &&
      request.policy.require_e2e &&
      !request.policy.e2e_available
    )
      return {
        gate,
        required: false,
        status: "NOT_APPLICABLE",
        reason: "E2E tooling is unavailable",
      };
    return required.has(gate)
      ? { gate, required: true, status: "FAIL", reason: "NOT_RUN" }
      : {
          gate,
          required: false,
          status: "NOT_APPLICABLE",
          reason: "Gate does not apply",
        };
  });
}

const personaFor = (gate: ValidationGate): Persona =>
  ({
    QA: "qa-engineer",
    SECURITY: "security-auditor",
    ACCESSIBILITY: "accessibility-auditor",
    CODE_REVIEW: "code-reviewer",
    E2E: "qa-engineer",
    RESPONSIVE: "qa-engineer",
    EVIDENCE: "evidence-agent",
  })[gate] as Persona;

const writableFor = (gate: ValidationGate): readonly string[] => {
  if (["QA", "E2E", "RESPONSIVE"].includes(gate))
    return ["tests/**", "e2e/**", "test-results/**", "playwright-report/**"];
  return [];
};
const matchesGrant = (path: string, grant: string): boolean =>
  grant.endsWith("/**")
    ? path.startsWith(grant.slice(0, -3) + "/")
    : path === grant;

function acceptanceResults(
  state: Pick<ValidationState, "acceptance_criteria" | "gates" | "evidence">,
): readonly AcceptanceResult[] {
  const requiredVerifier = state.gates
    .filter(
      (item) => item.required && (item.gate === "QA" || item.gate === "E2E"),
    )
    .map((item) => item.gate);
  return state.acceptance_criteria.map((criterion) => {
    const evidence = state.evidence.filter((item) =>
      item.acceptance_ids.includes(criterion.id),
    );
    const verified = requiredVerifier.filter((gate) => {
      const gateState = state.gates.find((item) => item.gate === gate);
      return (
        gateState?.status === "PASS" &&
        evidence.some((item) => gateState.evidence_ids.includes(item.id))
      );
    });
    return {
      acceptance_id: criterion.id,
      status:
        requiredVerifier.length > 0 &&
        verified.length === requiredVerifier.length
          ? "PASS"
          : "FAIL",
      verified_by: verified,
      evidence_ids: evidence
        .filter((item) =>
          verified.some((gate) =>
            state.gates
              .find((entry) => entry.gate === gate)
              ?.evidence_ids.includes(item.id),
          ),
        )
        .map((item) => item.id),
    };
  });
}

function finalize(state: ValidationState): ValidationState {
  const acceptance = acceptanceResults(state);
  const complete =
    state.gates.every((gate) => !gate.required || gate.status === "PASS") &&
    acceptance.every((item) => item.status === "PASS") &&
    state.repair.status === "COMPLETED" &&
    !state.gates.some((gate) =>
      gate.findings.some((finding) => finding.blocking),
    );
  return {
    ...state,
    acceptance_results: acceptance,
    proof_status:
      state.repair.status === "BLOCKED"
        ? "BLOCKED"
        : complete
          ? "COMPLETE"
          : "INCOMPLETE",
  };
}

export class ValidationOrchestrator {
  constructor(
    private readonly store: ValidationStore,
    private readonly dispatcher: ValidatorDispatcher,
    private readonly now: () => string,
    private readonly candidate: CandidateVerifier,
    private readonly boundary: ValidationBoundaryVerifier,
    private readonly evidenceVerifier: ValidationEvidenceVerifier,
    private readonly changes: ValidationChangeMonitor,
  ) {}

  async start(request: ValidationRequest): Promise<ValidationState> {
    assertSafePersistedContent(request);
    await this.candidate.assertCurrent(request.candidate_sha);
    if (await this.store.load(request.task_id))
      throw new Error("VALIDATION_ALREADY_EXISTS");
    const state = finalize({
      schema_version: "1",
      task_id: request.task_id,
      revision: 0,
      candidate_sha: request.candidate_sha,
      domains: [...request.domains],
      risk: request.risk,
      policy: { ...request.policy },
      acceptance_criteria: request.acceptance_criteria.map((item) => ({
        ...item,
      })),
      gates: planValidationGates(request).map((gate) => ({
        ...gate,
        candidate_sha: request.candidate_sha,
        evidence_ids: [],
        findings: [],
      })),
      evidence: [],
      acceptance_results: [],
      repair: createRepairState(request.task_id, []),
      proof_status: "INCOMPLETE",
      running_gate: null,
      events: [
        {
          type: "VALIDATION_STARTED",
          at: this.now(),
          candidate_sha: request.candidate_sha,
        },
      ],
      updated_at: this.now(),
    });
    await this.saveState(state, null);
    return state;
  }

  async runNext(
    taskId: string,
  ): Promise<"PROGRESSED" | "REPAIR_REQUIRED" | "COMPLETE"> {
    const state = await this.requiredState(taskId);
    if (state.running_gate) throw new Error("UNRECONCILED_VALIDATION_GATE");
    await this.candidate.assertCurrent(state.candidate_sha);
    const next = state.gates.find(
      (gate) => gate.required && gate.status !== "PASS",
    );
    if (!next)
      return state.proof_status === "COMPLETE" ? "COMPLETE" : "PROGRESSED";
    return this.runGate(taskId, next.gate);
  }

  async runGate(
    taskId: string,
    gate: ValidationGate,
  ): Promise<"PROGRESSED" | "REPAIR_REQUIRED"> {
    const state = await this.requiredState(taskId);
    if (state.running_gate) throw new Error("UNRECONCILED_VALIDATION_GATE");
    await this.candidate.assertCurrent(state.candidate_sha);
    const current = state.gates.find((entry) => entry.gate === gate);
    if (!current?.required) throw new Error("GATE_NOT_REQUIRED");
    const baseline = await this.changes.begin(writableFor(gate));
    const running: ValidationState = {
      ...state,
      revision: state.revision + 1,
      running_gate: gate,
      events: [
        ...state.events,
        {
          type: "GATE_STARTED",
          at: this.now(),
          gate,
          candidate_sha: state.candidate_sha,
        },
      ],
      updated_at: this.now(),
    };
    await this.saveState(running, state.revision);
    const writes = writableFor(gate);
    let suppliedResult: ValidatorResult;
    try {
      suppliedResult = await this.dispatcher.dispatch({
        task_id: taskId,
        candidate_sha: state.candidate_sha,
        gate,
        persona_id: personaFor(gate),
        read_only: writes.length === 0,
        allowed_write_paths: writes,
        acceptance_criteria: running.acceptance_criteria,
        expected_result: "STRUCTURED_VALIDATION_RESULT",
      });
    } catch (error) {
      await this.blockFailedGate(running, gate, baseline, error);
      throw error;
    }
    let actual: Awaited<ReturnType<ValidationChangeMonitor["collect"]>>;
    try {
      actual = await this.changes.collect(baseline);
    } catch (error) {
      await this.blockFailedGate(running, gate, baseline, error);
      throw error;
    }
    const parsedResult = ValidatorResultSchema.safeParse(suppliedResult);
    if (!parsedResult.success) {
      const error = new Error("INVALID_VALIDATOR_RESULT");
      await this.blockFailedGate(running, gate, baseline, error);
      throw error;
    }
    const result = parsedResult.data;
    try {
      assertSafePersistedContent(result);
    } catch (error) {
      await this.blockFailedGate(running, gate, baseline, error);
      throw error;
    }
    if (
      JSON.stringify([...actual.paths].sort()) !==
      JSON.stringify([...result.changed_paths].sort())
    ) {
      const error = new Error("VALIDATOR_CHANGE_REPORT_MISMATCH");
      await this.blockFailedGate(running, gate, baseline, error);
      throw error;
    }
    if (result.gate !== gate)
      return this.failGate(running, gate, baseline, "VALIDATION_GATE_MISMATCH");
    if (result.candidate_sha !== running.candidate_sha)
      return this.failGate(running, gate, baseline, "STALE_VALIDATION_RESULT");
    if (!["PASS", "FAIL", "NOT_APPLICABLE"].includes(result.status))
      return this.failGate(running, gate, baseline, "INVALID_GATE_STATUS");
    if (current.required && result.status === "NOT_APPLICABLE")
      return this.failGate(
        running,
        gate,
        baseline,
        "REQUIRED_GATE_NOT_APPLICABLE",
      );
    if (
      gate === "CODE_REVIEW" &&
      !["APPROVED", "CHANGES_REQUESTED"].includes(result.review_decision ?? "")
    )
      return this.failGate(running, gate, baseline, "INVALID_REVIEW_DECISION");
    if (
      gate === "CODE_REVIEW" &&
      (result.review_decision === "APPROVED") !== (result.status === "PASS")
    )
      return this.failGate(running, gate, baseline, "REVIEW_STATUS_MISMATCH");
    if (
      result.changed_paths.some(
        (path) => !writes.some((grant) => matchesGrant(path, grant)),
      )
    )
      return this.failGate(
        running,
        gate,
        baseline,
        "VALIDATOR_WRITE_VIOLATION",
      );
    try {
      await this.boundary.assertAllowed(personaFor(gate), actual.paths, writes);
    } catch (error) {
      await this.blockFailedGate(running, gate, baseline, error);
      throw error;
    }
    const ids = new Set(running.acceptance_criteria.map((item) => item.id));
    if (
      result.evidence.some(
        (item) =>
          !/^[a-f0-9]{64}$/.test(item.digest) ||
          item.candidate_sha !== running.candidate_sha ||
          item.producing_gate !== gate ||
          item.acceptance_ids.some((id) => !ids.has(id)),
      )
    )
      return this.failGate(
        running,
        gate,
        baseline,
        "INVALID_VALIDATION_EVIDENCE",
      );
    try {
      await this.evidenceVerifier.assertValid(
        taskId,
        running.candidate_sha,
        result.evidence,
      );
    } catch (error) {
      await this.blockFailedGate(running, gate, baseline, error);
      throw error;
    }
    let acceptedCandidate: string;
    try {
      acceptedCandidate = await this.changes.accept(baseline, gate);
    } catch (error) {
      await this.blockFailedGate(running, gate, baseline, error);
      throw error;
    }
    if (acceptedCandidate !== running.candidate_sha) {
      await this.persistCandidateInvalidation(running, acceptedCandidate);
      return "PROGRESSED";
    }
    try {
      await this.candidate.assertCurrent(running.candidate_sha);
    } catch (error) {
      await this.persistBlockedAfterAccept(running, gate, error);
      throw error;
    }
    const blocking = result.findings.filter((finding) => finding.blocking);
    const repair = blocking.length
      ? createRepairState(
          taskId,
          blocking.map((finding) => ({
            id: finding.finding_id,
            expected_owner: finding.expected_owner,
            summary: finding.message,
            affected_paths: [...finding.affected_paths],
          })),
        )
      : running.repair;
    const next = finalize({
      ...running,
      revision: running.revision + 1,
      running_gate: null,
      gates: running.gates.map((item) =>
        item.gate === gate
          ? {
              ...item,
              status: result.status,
              reason: result.reason ?? "VALIDATED",
              candidate_sha: running.candidate_sha,
              evidence_ids: result.evidence.map((evidence) => evidence.id),
              findings: [...result.findings],
            }
          : item,
      ),
      evidence: [
        ...running.evidence.filter(
          (item) => !current.evidence_ids.includes(item.id),
        ),
        ...result.evidence.map((item) => ({ ...item })),
      ],
      repair,
      events: [
        ...running.events,
        {
          type: result.status === "PASS" ? "GATE_PASSED" : "GATE_FAILED",
          at: this.now(),
          gate,
          candidate_sha: running.candidate_sha,
        },
      ],
      updated_at: this.now(),
    });
    await this.saveState(next, running.revision);
    return blocking.length ? "REPAIR_REQUIRED" : "PROGRESSED";
  }

  async bindCandidate(taskId: string, candidateSha: string): Promise<void> {
    await this.candidate.assertCurrent(candidateSha);
    const state = await this.requiredState(taskId);
    if (candidateSha === state.candidate_sha) return;
    const next = finalize({
      ...state,
      revision: state.revision + 1,
      candidate_sha: candidateSha,
      gates: state.gates.map((gate) =>
        gate.required
          ? {
              ...gate,
              status: "FAIL",
              reason: "STALE_CANDIDATE",
              candidate_sha: candidateSha,
              evidence_ids: [],
              findings: [],
            }
          : { ...gate, candidate_sha: candidateSha },
      ),
      evidence: [],
      repair: createRepairState(taskId, []),
      running_gate: null,
      events: [
        ...state.events,
        {
          type: "CANDIDATE_INVALIDATED",
          at: this.now(),
          candidate_sha: candidateSha,
        },
      ],
      updated_at: this.now(),
    });
    await this.saveState(next, state.revision);
  }

  async recordRepairOutcome(
    taskId: string,
    outcome: {
      readonly owner: Persona;
      readonly successful: boolean;
      readonly result: string;
      readonly remaining_finding_id: string | null;
    },
  ): Promise<void> {
    const state = await this.requiredState(taskId);
    if (!state.repair.owners.includes(outcome.owner))
      throw new Error("REPAIR_OWNER_MISMATCH");
    if (state.repair.attempts >= 3)
      throw new Error("Repair attempt ceiling reached");
    const repair = applyRepairResult(
      state.repair,
      {
        successful: outcome.successful,
        result: outcome.result,
        remaining_blocker: outcome.remaining_finding_id,
      },
      this.now(),
    );
    const next = finalize({
      ...state,
      revision: state.revision + 1,
      repair,
      events: [
        ...state.events,
        {
          type:
            repair.status === "BLOCKED" ? "REPAIR_BLOCKED" : "REPAIR_RECORDED",
          at: this.now(),
          candidate_sha: state.candidate_sha,
        },
      ],
      updated_at: this.now(),
    });
    await this.saveState(next, state.revision);
  }

  private async requiredState(taskId: string): Promise<ValidationState> {
    const state = await this.store.load(taskId);
    if (!state) throw new Error("VALIDATION_NOT_FOUND");
    return state;
  }

  private async failGate(
    running: ValidationState,
    gate: ValidationGate,
    baseline: string,
    message: string,
  ): Promise<never> {
    const error = new Error(message);
    await this.blockFailedGate(running, gate, baseline, error);
    throw error;
  }

  private async blockFailedGate(
    running: ValidationState,
    gate: ValidationGate,
    baseline: string,
    error: unknown,
  ): Promise<void> {
    let reason = stableFailureReason(error);
    try {
      await this.changes.reject(baseline);
    } catch {
      reason = `${reason}_ROLLBACK_FAILED`;
    }
    await this.saveState(
      {
        ...running,
        revision: running.revision + 1,
        running_gate: null,
        proof_status: "BLOCKED",
        gates: running.gates.map((item) =>
          item.gate === gate ? { ...item, status: "FAIL", reason } : item,
        ),
        events: [
          ...running.events,
          {
            type: "GATE_BLOCKED",
            at: this.now(),
            gate,
            candidate_sha: running.candidate_sha,
          },
        ],
        updated_at: this.now(),
      },
      running.revision,
    );
  }

  private async persistBlockedAfterAccept(
    running: ValidationState,
    gate: ValidationGate,
    error: unknown,
  ): Promise<void> {
    const reason = stableFailureReason(error);
    await this.saveState(
      {
        ...running,
        revision: running.revision + 1,
        running_gate: null,
        proof_status: "BLOCKED",
        gates: running.gates.map((item) =>
          item.gate === gate ? { ...item, status: "FAIL", reason } : item,
        ),
        events: [
          ...running.events,
          {
            type: "GATE_BLOCKED_AFTER_ACCEPT",
            at: this.now(),
            gate,
            candidate_sha: running.candidate_sha,
          },
        ],
        updated_at: this.now(),
      },
      running.revision,
    );
  }

  private async persistCandidateInvalidation(
    running: ValidationState,
    candidateSha: string,
  ): Promise<void> {
    await this.saveState(
      finalize({
        ...running,
        revision: running.revision + 1,
        running_gate: null,
        candidate_sha: candidateSha,
        gates: running.gates.map((gate) =>
          gate.required
            ? {
                ...gate,
                status: "FAIL",
                reason: "STALE_CANDIDATE",
                candidate_sha: candidateSha,
                evidence_ids: [],
                findings: [],
              }
            : { ...gate, candidate_sha: candidateSha },
        ),
        evidence: [],
        repair: createRepairState(running.task_id, []),
        events: [
          ...running.events,
          {
            type: "CANDIDATE_INVALIDATED",
            at: this.now(),
            candidate_sha: candidateSha,
          },
        ],
        updated_at: this.now(),
      }),
      running.revision,
    );
  }

  private async saveState(
    state: ValidationState,
    expectedRevision: number | null,
  ): Promise<void> {
    assertSafePersistedContent(state);
    await this.store.save(state, expectedRevision);
  }
}
