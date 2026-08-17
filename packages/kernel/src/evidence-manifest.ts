import { z } from "zod";
import { normalizeRepoPath } from "./ownership.js";
import { AcceptanceProofSchema } from "./acceptance.js";
import {
  CandidateCommitSchema,
  ValidationGateResultSchema,
  ValidationGateSchema,
} from "./validation-contracts.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ArtifactKindSchema = z.enum([
  "SCREENSHOT",
  "VIDEO",
  "TEST_REPORT",
  "QA_REPORT",
  "SECURITY_REPORT",
  "ACCESSIBILITY_REPORT",
  "REVIEW_REPORT",
  "RESPONSIVE_REPORT",
  "DOCUMENTATION",
]);
const ViewportSchema = z
  .object({
    name: z.enum(["desktop", "tablet", "mobile"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
  .readonly();
const TimelineSegmentSchema = z
  .object({
    acceptance_id: z.string().min(1),
    start_seconds: z.number().nonnegative(),
    end_seconds: z.number().positive(),
  })
  .strict()
  .refine((segment) => segment.end_seconds > segment.start_seconds, {
    message: "Video segment must have positive duration",
  })
  .readonly();

export const EvidenceArtifactSchema = z
  .object({
    id: z.string().min(1),
    kind: ArtifactKindSchema,
    path: z.string().min(1),
    sha256: DigestSchema,
    candidate_commit: CandidateCommitSchema,
    producing_gate: ValidationGateSchema,
    tool: z.string().min(1),
    acceptance_ids: z.array(z.string().min(1)),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    let path: string;
    try {
      path = normalizeRepoPath(artifact.path);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "Invalid artifact path",
      });
      return;
    }
    if (!path.startsWith(".forge/artifacts/"))
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "Artifact must be contained under .forge/artifacts",
      });
    if (artifact.kind === "SCREENSHOT") {
      const parsed = z
        .object({ viewport: ViewportSchema })
        .strict()
        .safeParse(artifact.metadata);
      if (!parsed.success)
        ctx.addIssue({
          code: "custom",
          path: ["metadata"],
          message: "Screenshot requires exact viewport metadata",
        });
    }
    if (artifact.kind === "VIDEO") {
      const parsed = z
        .object({
          format: z.enum(["webm", "mp4"]),
          segments: z.array(TimelineSegmentSchema).min(1),
        })
        .strict()
        .safeParse(artifact.metadata);
      if (!parsed.success)
        ctx.addIssue({
          code: "custom",
          path: ["metadata"],
          message: "Video requires format and acceptance timeline",
        });
    }
    if (artifact.kind === "RESPONSIVE_REPORT") {
      const parsed = z
        .object({ viewport: ViewportSchema })
        .strict()
        .safeParse(artifact.metadata);
      if (!parsed.success)
        ctx.addIssue({
          code: "custom",
          path: ["metadata"],
          message: "Responsive evidence requires viewport metadata",
        });
    }
  })
  .readonly();

const DocumentationReferenceSchema = z
  .object({
    name: z.enum([
      "SUMMARY.md",
      "IMPLEMENTATION.md",
      "TESTING.md",
      "CHANGES.md",
    ]),
    artifact_id: z.string().min(1),
  })
  .strict()
  .readonly();

export const EvidenceManifestSchema = z
  .object({
    schema_version: z.literal("1"),
    task_id: z.string().min(1),
    candidate_commit: CandidateCommitSchema,
    generated_at: z.string().datetime(),
    acceptance_criteria: z.array(AcceptanceProofSchema),
    gate_results: z.array(ValidationGateResultSchema),
    artifacts: z.array(EvidenceArtifactSchema),
    documentation: z.array(DocumentationReferenceSchema),
    known_limitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const artifactIds = manifest.artifacts.map((artifact) => artifact.id);
    if (new Set(artifactIds).size !== artifactIds.length)
      ctx.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "Duplicate artifact id",
      });
    const knownArtifacts = new Set(artifactIds);
    const acceptanceIds = new Set(
      manifest.acceptance_criteria.map((proof) => proof.acceptance_criterion),
    );
    const references = [
      ...manifest.gate_results.flatMap((gate) => gate.evidence_refs),
      ...manifest.acceptance_criteria.flatMap((proof) => proof.evidence_refs),
      ...manifest.documentation.map((document) => document.artifact_id),
    ];
    if (references.some((reference) => !knownArtifacts.has(reference)))
      ctx.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "Dangling evidence reference",
      });
    const artifactById = new Map(
      manifest.artifacts.map((artifact) => [artifact.id, artifact]),
    );
    if (
      manifest.documentation.some(
        (document) =>
          artifactById.get(document.artifact_id)?.kind !== "DOCUMENTATION",
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["documentation"],
        message:
          "Documentation references must identify documentation artifacts",
      });
    if (
      manifest.artifacts.some(
        (artifact) =>
          !artifact.path.startsWith(`.forge/artifacts/${manifest.task_id}/`),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "Artifact path must be contained in the task namespace",
      });
    if (
      manifest.artifacts.some((artifact) =>
        artifact.acceptance_ids.some((id) => !acceptanceIds.has(id)),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "Artifact references unknown acceptance criterion",
      });
    if (
      manifest.acceptance_criteria.some((proof) =>
        proof.evidence_refs.some(
          (reference) =>
            !artifactById
              .get(reference)
              ?.acceptance_ids.includes(proof.acceptance_criterion),
        ),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["acceptance_criteria"],
        message: "Acceptance evidence must be associated with its criterion",
      });
  })
  .readonly();
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

export function evaluateEvidenceManifest(
  manifestInput: unknown,
  candidateCommit: string,
  observedDigests: Readonly<Record<string, string>>,
): {
  readonly valid: boolean;
  readonly stale: boolean;
  readonly failures: readonly string[];
} {
  const parsed = EvidenceManifestSchema.safeParse(manifestInput);
  if (!parsed.success)
    return Object.freeze({
      valid: false,
      stale: false,
      failures: ["INVALID_EVIDENCE_MANIFEST"],
    });
  const manifest = parsed.data;
  const failures: string[] = [];
  if (manifest.candidate_commit !== candidateCommit)
    failures.push("STALE_MANIFEST");
  for (const artifact of manifest.artifacts) {
    if (artifact.candidate_commit !== candidateCommit)
      failures.push(`STALE_ARTIFACT:${artifact.id}`);
    if (observedDigests[artifact.id] !== artifact.sha256)
      failures.push(`DIGEST_MISMATCH:${artifact.id}`);
  }
  for (const gate of manifest.gate_results)
    if (gate.candidate_commit !== candidateCommit)
      failures.push(`STALE_GATE:${gate.gate}`);
  for (const proof of manifest.acceptance_criteria)
    if (proof.candidate_commit !== candidateCommit)
      failures.push(`STALE_ACCEPTANCE_PROOF:${proof.acceptance_criterion}`);
  const unique = [...new Set(failures)];
  return Object.freeze({
    valid: unique.length === 0,
    stale: unique.some((failure) => failure.startsWith("STALE_")),
    failures: unique,
  });
}
