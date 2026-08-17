import { z } from "zod";
import { SafeStateStore } from "../../adapters/src/safe-state-store.js";
import { PersonaSchema } from "../../kernel/src/contracts.js";
import {
  VALIDATION_GATES,
  type ValidationState,
  type ValidationStore,
} from "./validation-orchestrator.js";

const GateSchema = z.enum(VALIDATION_GATES);
const FindingSchema = z
  .object({
    finding_id: z.string(),
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    acceptance_criterion: z.string().optional(),
    category: z.string().optional(),
    evidence: z.array(z.string()),
    expected_owner: PersonaSchema,
    blocking: z.boolean(),
    message: z.string(),
    affected_paths: z.array(z.string()),
    recommendation: z.string().optional(),
  })
  .strict();
const GateStateSchema = z
  .object({
    gate: GateSchema,
    required: z.boolean(),
    status: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
    reason: z.string(),
    candidate_sha: z.string(),
    evidence_ids: z.array(z.string()),
    findings: z.array(FindingSchema),
  })
  .strict();
const RepairSchema = z
  .object({
    task_id: z.string(),
    attempts: z.number().int().min(0).max(3),
    status: z.enum(["REPAIRING", "COMPLETED", "BLOCKED"]),
    findings: z.array(
      z
        .object({
          id: z.string(),
          expected_owner: PersonaSchema,
          summary: z.string(),
          affected_paths: z.array(z.string()),
        })
        .strict(),
    ),
    owners: z.array(PersonaSchema),
    results: z.array(
      z
        .object({
          attempt: z.number().int().positive(),
          successful: z.boolean(),
          result: z.string(),
          at: z.string(),
        })
        .strict(),
    ),
    remaining_blocker: z.string().nullable(),
  })
  .strict();

export const ValidationStateSchema: z.ZodType<ValidationState> = z
  .object({
    schema_version: z.literal("1"),
    task_id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    candidate_sha: z.string().min(1),
    domains: z.array(
      z.enum(["frontend", "backend", "database", "mobile", "infrastructure"]),
    ),
    risk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    policy: z
      .object({
        e2e_available: z.boolean().optional(),
        require_e2e: z.boolean().optional(),
        security_relevant: z.boolean().optional(),
        force_gates: z.array(GateSchema).optional(),
      })
      .strict(),
    acceptance_criteria: z.array(
      z.object({ id: z.string(), text: z.string() }).strict(),
    ),
    gates: z.array(GateStateSchema),
    evidence: z.array(
      z
        .object({
          id: z.string(),
          acceptance_ids: z.array(z.string()),
          reference: z.string(),
          digest: z.string(),
          candidate_sha: z.string(),
          producing_gate: GateSchema,
        })
        .strict(),
    ),
    acceptance_results: z.array(
      z
        .object({
          acceptance_id: z.string(),
          status: z.enum(["PASS", "FAIL"]),
          verified_by: z.array(GateSchema),
          evidence_ids: z.array(z.string()),
        })
        .strict(),
    ),
    repair: RepairSchema,
    proof_status: z.enum(["INCOMPLETE", "COMPLETE", "BLOCKED"]),
    running_gate: GateSchema.nullable(),
    events: z.array(
      z
        .object({
          type: z.string(),
          at: z.string(),
          gate: GateSchema.optional(),
          candidate_sha: z.string(),
        })
        .strict(),
    ),
    updated_at: z.string(),
  })
  .strict();

export class DurableValidationStore implements ValidationStore {
  readonly #store: SafeStateStore<ValidationState>;

  constructor(repositoryRoot: string) {
    this.#store = new SafeStateStore(
      repositoryRoot,
      ValidationStateSchema,
      "validation",
    );
  }

  async load(taskId: string): Promise<ValidationState | undefined> {
    try {
      return await this.#store.load(taskId);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  save(state: ValidationState, expectedRevision: number | null): Promise<void> {
    return expectedRevision === null
      ? this.#store.save(state.task_id, state, undefined, true)
      : this.#store.save(state.task_id, state, expectedRevision);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
