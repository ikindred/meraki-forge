import { describe, expect, it } from "vitest";
import {
  approveAndPersistOwnershipReview,
  approveOwnershipReview,
  createOwnershipReview,
} from "../packages/execution/src/ownership-review.js";

const repo = "/tmp/forge-owner-review";
const head = "a".repeat(40);

describe("ownership review", () => {
  it("keeps ambiguous and broad paths denied before explicit approval", () => {
    const review = createOwnershipReview({
      repositoryPath: repo,
      candidateCommit: head,
      candidates: [
        {
          pattern: "app/**",
          owner: "frontend-engineer",
          evidence: ["package.json"],
        },
        {
          pattern: "app/api/**",
          owner: "backend-engineer",
          evidence: ["app/api/route.ts"],
        },
        {
          pattern: "app/ui/**",
          owner: "frontend-engineer",
          evidence: ["app/ui/page.tsx"],
        },
        {
          pattern: "shared/**",
          owner: "frontend-engineer",
          evidence: ["shared/package.json"],
        },
        {
          pattern: "shared/**",
          owner: "backend-engineer",
          evidence: ["shared/package.json"],
        },
      ],
    });
    expect(review.status).toBe("AWAITING_HUMAN_APPROVAL");
    expect(review.proposal.default_effect).toBe("deny");
    expect(review.proposal.rules.map((rule) => rule.pattern)).toEqual([
      "app/api/**",
      "app/ui/**",
    ]);
    expect(review.proposal.ambiguities.map((item) => item.pattern)).toEqual([
      "app/**",
      "shared/**",
    ]);
  });

  it("binds approval to the exact proposal, repository, and HEAD", () => {
    const review = createOwnershipReview({
      repositoryPath: repo,
      candidateCommit: head,
      candidates: [
        {
          pattern: "frontend/components/**",
          owner: "frontend-engineer",
          evidence: ["frontend/package.json"],
        },
      ],
    });
    const approval = {
      approved: true as const,
      approved_by: "Human Operator",
      approved_at: "2026-08-17T00:00:00.000Z",
      repository_path: repo,
      candidate_commit: head,
      proposal_digest: review.proposal_digest,
    };
    expect(approveOwnershipReview(review, approval)).toMatchObject({
      default_effect: "deny",
      ambiguities: [],
      rules: [
        { pattern: "frontend/components/**", owner: "frontend-engineer" },
      ],
    });
    expect(() =>
      approveOwnershipReview(review, {
        ...approval,
        candidate_commit: "b".repeat(40),
      }),
    ).toThrow(/does not match/u);
    expect(() =>
      approveOwnershipReview(review, {
        ...approval,
        proposal_digest: "0".repeat(64),
      }),
    ).toThrow(/does not match/u);
  });

  it("persists only after approval validation", async () => {
    const review = createOwnershipReview({
      repositoryPath: repo,
      candidateCommit: head,
      candidates: [
        {
          pattern: "server/routes/**",
          owner: "backend-engineer",
          evidence: ["server/routes/index.ts"],
        },
      ],
    });
    const writes: unknown[] = [];
    const store = {
      writeApprovedPolicy: (_repositoryPath: string, policy: unknown) => {
        writes.push(policy);
        return Promise.resolve();
      },
    };
    const base = {
      approved: true as const,
      approved_by: "Human Operator",
      approved_at: "2026-08-17T00:00:00.000Z",
      repository_path: repo,
      candidate_commit: head,
      proposal_digest: review.proposal_digest,
    };
    await expect(
      approveAndPersistOwnershipReview(
        review,
        { ...base, repository_path: "/tmp/wrong" },
        store,
      ),
    ).rejects.toThrow(/does not match/u);
    expect(writes).toEqual([]);
    await approveAndPersistOwnershipReview(review, base, store);
    expect(writes).toHaveLength(1);
  });
});
