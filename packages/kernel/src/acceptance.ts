import { z } from "zod";
import {
  CandidateCommitSchema,
  ValidationGateSchema,
  ValidationStatusSchema,
} from "./validation-contracts.js";

export const AcceptanceProofSchema = z
  .object({
    schema_version: z.literal("1"),
    acceptance_criterion: z.string().min(1),
    required: z.boolean(),
    status: ValidationStatusSchema,
    candidate_commit: CandidateCommitSchema,
    verified_by: z.array(ValidationGateSchema),
    evidence_refs: z.array(z.string().min(1)),
    reason: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((proof, ctx) => {
    if (
      proof.status === "PASS" &&
      (proof.verified_by.length === 0 || proof.evidence_refs.length === 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "PASS requires validators and evidence",
      });
    if (proof.required && proof.status === "NOT_APPLICABLE")
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "A required acceptance criterion cannot be NOT_APPLICABLE",
      });
    if (proof.status === "NOT_APPLICABLE" && proof.reason === null)
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "NOT_APPLICABLE requires a reason",
      });
  })
  .readonly();
export type AcceptanceProof = z.infer<typeof AcceptanceProofSchema>;

export function evaluateAcceptanceCompleteness(
  requiredAcceptanceIds: readonly string[],
  proofInputs: readonly unknown[],
  candidateCommit: string,
  evidenceIds: ReadonlySet<string>,
): { readonly complete: boolean; readonly failures: readonly string[] } {
  const failures: string[] = [];
  const proofs = proofInputs.flatMap((input) => {
    const parsed = AcceptanceProofSchema.safeParse(input);
    if (!parsed.success) {
      failures.push("INVALID_ACCEPTANCE_PROOF");
      return [];
    }
    return [parsed.data];
  });
  const duplicates = new Set<string>();
  const byId = new Map<string, AcceptanceProof>();
  for (const proof of proofs) {
    if (byId.has(proof.acceptance_criterion))
      duplicates.add(proof.acceptance_criterion);
    byId.set(proof.acceptance_criterion, proof);
  }
  for (const id of [...duplicates].sort())
    failures.push(`DUPLICATE_ACCEPTANCE_PROOF:${id}`);
  for (const id of requiredAcceptanceIds) {
    const proof = byId.get(id);
    if (!proof) {
      failures.push(`MISSING_ACCEPTANCE_PROOF:${id}`);
      continue;
    }
    if (proof.candidate_commit !== candidateCommit)
      failures.push(`STALE_ACCEPTANCE_PROOF:${id}`);
    if (proof.status !== "PASS") failures.push(`ACCEPTANCE_NOT_PASSING:${id}`);
    if (proof.evidence_refs.some((reference) => !evidenceIds.has(reference)))
      failures.push(`ACCEPTANCE_EVIDENCE_INVALID:${id}`);
  }
  const unique = [...new Set(failures)];
  return Object.freeze({ complete: unique.length === 0, failures: unique });
}
