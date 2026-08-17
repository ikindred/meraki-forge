import { z } from "zod";

export const PERSONAS = [
  "forge-director",
  "engineering-coordinator",
  "architect",
  "frontend-engineer",
  "backend-engineer",
  "mobile-engineer",
  "database-architect",
  "uiux-designer",
  "qa-engineer",
  "security-auditor",
  "accessibility-auditor",
  "code-reviewer",
  "integration-agent",
  "evidence-agent",
  "release-agent",
] as const;
export const PersonaSchema = z.enum(PERSONAS);
export type Persona = z.infer<typeof PersonaSchema>;

export const TaskModeSchema = z.enum([
  "AUTO",
  "PLAN",
  "DISCUSS",
  "HOLD",
  "HOTFIX",
  "REVIEW",
]);
export const TaskStatusSchema = z.enum([
  "READY",
  "IN_PROGRESS",
  "BLOCKED",
  "DISCUSS",
  "REVIEW",
  "DONE",
]);
export const PhaseSchema = z.enum([
  "INTAKE",
  "RECONCILING",
  "AUTHORIZED",
  "CLAIMED",
  "PLANNING",
  "IMPLEMENTING",
  "OWNERSHIP_CHECK",
  "INTEGRATING",
  "VALIDATING",
  "REPAIRING",
  "EVIDENCE",
  "RELEASE_GATE",
  "PR_CREATING",
  "DELIVERED",
  "BLOCKED",
]);
export const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const GateStatusSchema = z.enum([
  "PASS",
  "FAIL",
  "NOT_APPLICABLE",
  "SKIPPED",
]);

export const AcceptanceCriterionSchema = z
  .object({ id: z.string().min(1), text: z.string().min(1) })
  .readonly();
export const TaskContractSchema = z
  .object({
    schema_version: z.literal("1"),
    id: z.string().min(1),
    title: z.string().min(1),
    mode: TaskModeSchema,
    priority: z.enum(["P0", "P1", "P2", "P3"]),
    outcome: z.string().min(1),
    acceptance_criteria: z.array(AcceptanceCriterionSchema),
    constraints: z.array(z.string()).default([]),
    known_dependencies: z.array(z.string()).default([]),
    notes: z.string().default(""),
  })
  .superRefine((task, ctx) => {
    if (
      ["AUTO", "HOTFIX"].includes(task.mode) &&
      task.acceptance_criteria.length === 0
    )
      ctx.addIssue({
        code: "custom",
        path: ["acceptance_criteria"],
        message: "Executable tasks require acceptance criteria",
      });
  })
  .readonly();
export type TaskContract = z.infer<typeof TaskContractSchema>;

const envelope = {
  schema_version: z.literal("1"),
  id: z.string(),
  task_id: z.string(),
  run_id: z.string(),
  from: PersonaSchema,
  to: PersonaSchema,
  created_at: z.string().datetime(),
};
const affected = {
  reason: z.string().min(1),
  affected_paths: z.array(z.string()),
  blocking: z.boolean(),
};
const finding = {
  ...affected,
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  evidence: z.array(z.string()).min(1),
  required_property: z.string(),
  expected_owner: PersonaSchema,
};
export const ForgeMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("DEPENDENCY_REQUEST"),
    ...envelope,
    payload: z.object({
      ...affected,
      requested_owner: PersonaSchema,
      domain: z.string(),
      required_output: z.string(),
      acceptance_ids: z.array(z.string()),
    }),
  }),
  z.object({
    kind: z.literal("CONTRACT_CHANGE_REQUEST"),
    ...envelope,
    payload: z.object({
      ...affected,
      proposed_revision: z.number().int().positive(),
      change: z.string(),
    }),
  }),
  z.object({
    kind: z.literal("SEMANTIC_CONFLICT"),
    ...envelope,
    payload: z.object({
      ...affected,
      alternatives: z.array(z.string()).min(2),
    }),
  }),
  z.object({
    kind: z.literal("BLOCKER_REPORT"),
    ...envelope,
    payload: z.object({ ...affected, recommended_action: z.string() }),
  }),
  z.object({
    kind: z.literal("SECURITY_FINDING"),
    ...envelope,
    payload: z.object(finding),
  }),
  z.object({
    kind: z.literal("QA_FINDING"),
    ...envelope,
    payload: z.object(finding),
  }),
  z.object({
    kind: z.literal("REVIEW_FINDING"),
    ...envelope,
    payload: z.object(finding),
  }),
]);

export const GateResultSchema = z
  .object({
    id: z.string(),
    status: GateStatusSchema,
    candidate_sha: z.string(),
    evidence_ids: z.array(z.string()),
    reason: z.string(),
  })
  .readonly();
export const EvidenceItemSchema = z
  .object({
    id: z.string(),
    acceptance_ids: z.array(z.string()),
    kind: z.string(),
    location: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    tool: z.string(),
    result: z.enum(["PASS", "FAIL"]),
    captured_at: z.string().datetime(),
    candidate_sha: z.string(),
  })
  .readonly();

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
