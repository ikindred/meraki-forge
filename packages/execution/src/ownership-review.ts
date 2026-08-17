import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  proposeOwnership,
  type OwnershipCandidate,
  type OwnershipProposal,
} from "../../kernel/src/bootstrap-composition.js";

const GitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const BROAD_PATTERNS = new Set(["app/**", "src/**", "lib/**", "packages/**"]);

export type OwnershipReview = Readonly<{
  schema_version: "1";
  repository_path: string;
  candidate_commit: string;
  proposal: OwnershipProposal;
  proposal_digest: string;
  status: "AWAITING_HUMAN_APPROVAL";
}>;

export type OwnershipApproval = Readonly<{
  approved: true;
  approved_by: string;
  approved_at: string;
  repository_path: string;
  candidate_commit: string;
  proposal_digest: string;
}>;

export type ApprovedOwnershipFile = Readonly<{
  schema_version: "1";
  default_effect: "deny";
  rules: OwnershipProposal["rules"];
  ambiguities: readonly string[];
  review: Readonly<{
    approved_by: string;
    approved_at: string;
    repository_path: string;
    candidate_commit: string;
    proposal_digest: string;
    policy_digest: string;
  }>;
}>;

export interface OwnershipPolicyStore {
  /** Implementations must use conflict-safe atomic replacement. */
  writeApprovedPolicy(
    repositoryPath: string,
    policy: ApprovedOwnershipFile,
  ): Promise<void>;
}

/** Produce a deterministic, commit-bound proposal. Broad convenience grants are denied. */
export function createOwnershipReview(
  input: Readonly<{
    repositoryPath: string;
    candidateCommit: string;
    candidates: readonly OwnershipCandidate[];
  }>,
): OwnershipReview {
  if (!isAbsolute(input.repositoryPath))
    throw new Error("Ownership review repository path must be absolute");
  GitCommitSchema.parse(input.candidateCommit);
  const candidates = input.candidates.map((candidate) =>
    BROAD_PATTERNS.has(candidate.pattern.replaceAll("\\", "/"))
      ? { ...candidate, evidence: [] }
      : candidate,
  );
  const proposal = proposeOwnership(candidates);
  const proposalDigest = digest({
    repository_path: input.repositoryPath,
    candidate_commit: input.candidateCommit,
    proposal,
  });
  return Object.freeze({
    schema_version: "1",
    repository_path: input.repositoryPath,
    candidate_commit: input.candidateCommit,
    proposal,
    proposal_digest: proposalDigest,
    status: "AWAITING_HUMAN_APPROVAL",
  });
}

/** Convert a proposal to writable policy only after exact, explicit human approval. */
export function approveOwnershipReview(
  review: OwnershipReview,
  approval: OwnershipApproval,
): ApprovedOwnershipFile {
  const ambiguities = review.proposal.ambiguities.map(
    (item) => `${item.pattern}: ${item.reason}`,
  );
  if (!approval.approved || !approval.approved_by.trim())
    throw new Error("Explicit named human approval is required");
  if (!Number.isFinite(Date.parse(approval.approved_at)))
    throw new Error("Approval timestamp is invalid");
  if (
    approval.repository_path !== review.repository_path ||
    approval.candidate_commit !== review.candidate_commit ||
    approval.proposal_digest !== review.proposal_digest
  )
    throw new Error(
      "Ownership approval does not match repository, HEAD, and proposal digest",
    );
  if (
    digest({
      repository_path: review.repository_path,
      candidate_commit: review.candidate_commit,
      proposal: review.proposal,
    }) !== review.proposal_digest
  )
    throw new Error("Ownership proposal integrity check failed");
  return Object.freeze({
    schema_version: "1",
    default_effect: "deny",
    rules: review.proposal.rules,
    ambiguities,
    review: Object.freeze({
      approved_by: approval.approved_by.trim(),
      approved_at: approval.approved_at,
      repository_path: approval.repository_path,
      candidate_commit: approval.candidate_commit,
      proposal_digest: approval.proposal_digest,
      policy_digest: digest({
        repository_path: approval.repository_path,
        candidate_commit: approval.candidate_commit,
        rules: review.proposal.rules,
        ambiguities,
      }),
    }),
  });
}

export function verifyApprovedOwnershipPolicy(
  policy: ApprovedOwnershipFile,
  repositoryPath: string,
  candidateCommit: string,
): boolean {
  return (
    policy.review.repository_path === repositoryPath &&
    policy.review.candidate_commit === candidateCommit &&
    policy.review.policy_digest ===
      digest({
        repository_path: repositoryPath,
        candidate_commit: candidateCommit,
        rules: policy.rules,
        ambiguities: policy.ambiguities,
      })
  );
}

export async function approveAndPersistOwnershipReview(
  review: OwnershipReview,
  approval: OwnershipApproval,
  store: OwnershipPolicyStore,
): Promise<ApprovedOwnershipFile> {
  const policy = approveOwnershipReview(review, approval);
  await store.writeApprovedPolicy(review.repository_path, policy);
  return policy;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
