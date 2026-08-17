import { z } from "zod";
import { PersonaSchema } from "./contracts.js";

const CandidateCommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const SeveritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const ImplementationOwnerSchema = PersonaSchema.refine(
  (persona) =>
    [
      "frontend-engineer",
      "backend-engineer",
      "mobile-engineer",
      "database-architect",
    ].includes(persona),
  "A finding must route to an implementation owner",
);

export const ValidationStatusSchema = z.enum([
  "PASS",
  "FAIL",
  "NOT_APPLICABLE",
]);
export const ValidationGateSchema = z.enum([
  "QA",
  "SECURITY",
  "ACCESSIBILITY",
  "CODE_REVIEW",
  "E2E",
  "RESPONSIVE",
  "EVIDENCE",
]);
export type ValidationGate = z.infer<typeof ValidationGateSchema>;

export const QAFindingSchema = z
  .object({
    schema_version: z.literal("1"),
    finding_id: z.string().min(1),
    severity: SeveritySchema,
    acceptance_criterion: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1),
    expected_owner: ImplementationOwnerSchema,
    blocking: z.boolean(),
    message: z.string().min(1),
  })
  .strict()
  .readonly();

export const SecurityFindingSchema = z
  .object({
    schema_version: z.literal("1"),
    finding_id: z.string().min(1),
    severity: SeveritySchema,
    category: z.string().min(1),
    affected_files: z.array(z.string().min(1)).min(1),
    evidence: z.array(z.string().min(1)).min(1),
    expected_owner: ImplementationOwnerSchema,
    blocking: z.boolean(),
    recommendation: z.string().min(1),
  })
  .strict()
  .readonly();

export const AccessibilityFindingSchema = z
  .object({
    schema_version: z.literal("1"),
    finding_id: z.string().min(1),
    severity: SeveritySchema,
    category: z.string().min(1),
    affected_files: z.array(z.string().min(1)).min(1),
    evidence: z.array(z.string().min(1)).min(1),
    expected_owner: z.enum(["frontend-engineer", "mobile-engineer"]),
    blocking: z.boolean(),
    message: z.string().min(1),
  })
  .strict()
  .readonly();

export const ReviewFindingSchema = z
  .object({
    schema_version: z.literal("1"),
    finding_id: z.string().min(1),
    severity: SeveritySchema,
    category: z.string().min(1),
    affected_files: z.array(z.string().min(1)).min(1),
    evidence: z.array(z.string().min(1)).min(1),
    expected_owner: ImplementationOwnerSchema,
    blocking: z.boolean(),
    message: z.string().min(1),
  })
  .strict()
  .readonly();

export const ReviewerResultSchema = z
  .object({
    schema_version: z.literal("1"),
    candidate_commit: CandidateCommitSchema,
    outcome: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
    findings: z.array(ReviewFindingSchema),
    completed_at: z.string().datetime(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.outcome === "APPROVED" && result.findings.length > 0)
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "APPROVED cannot include findings",
      });
    if (result.outcome === "CHANGES_REQUESTED" && result.findings.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "CHANGES_REQUESTED requires structured findings",
      });
  })
  .readonly();

export const ValidationGateResultSchema = z
  .object({
    schema_version: z.literal("1"),
    gate: ValidationGateSchema,
    status: ValidationStatusSchema,
    candidate_commit: CandidateCommitSchema,
    evidence_refs: z.array(z.string().min(1)),
    finding_ids: z.array(z.string().min(1)),
    reason: z.string().min(1).nullable(),
    completed_at: z.string().datetime(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status === "PASS" && result.evidence_refs.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["evidence_refs"],
        message: "PASS requires evidence",
      });
    if (result.status === "FAIL" && result.finding_ids.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["finding_ids"],
        message: "FAIL requires findings",
      });
    if (result.status === "NOT_APPLICABLE" && result.reason === null)
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "NOT_APPLICABLE requires a reason",
      });
    if (
      result.status === "NOT_APPLICABLE" &&
      (result.evidence_refs.length > 0 || result.finding_ids.length > 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "NOT_APPLICABLE cannot claim evidence or findings",
      });
  })
  .readonly();

export { CandidateCommitSchema, SeveritySchema };
