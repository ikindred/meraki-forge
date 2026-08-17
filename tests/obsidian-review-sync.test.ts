import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ObsidianReviewSyncError,
  syncObsidianReview,
} from "../packages/adapters/src/obsidian-review-sync.js";

const review = {
  task_id: "TASK-42",
  status: "REVIEW" as const,
  pr_number: 42,
  repository: { host: "github.com", owner: "acme", name: "forge" },
  pr_url: "https://github.com/acme/forge/pull/42",
  candidate_sha: "a".repeat(40),
  qa: "PASS",
  security: "PASS",
  accessibility: "PASS",
  code_review: "PASS",
  evidence_summary: "3 candidate-bound artifacts",
  known_limitations: ["Manual screen reader pending"],
  human_action_required:
    "Review this PR. Choose Merge, Request Changes, or Reject.",
};

describe("Obsidian REVIEW sync", () => {
  it("atomically updates only Forge-owned REVIEW content and preserves human text", async () => {
    const vault = await mkdtemp(join(tmpdir(), "forge-review-"));
    await mkdir(join(vault, "Tasks"));
    const path = join(vault, "Tasks", "TASK-42.md");
    await writeFile(
      path,
      "---\ntitle: Keep this title\nstatus: IN_PROGRESS\n---\n\nHuman notes stay exactly here.\n",
    );

    await syncObsidianReview(vault, "Tasks/TASK-42.md", review);
    const first = await readFile(path, "utf8");
    await syncObsidianReview(vault, "Tasks/TASK-42.md", review);
    const second = await readFile(path, "utf8");

    expect(second).toBe(first);
    expect(second).toContain("title: Keep this title");
    expect(second).toContain("status: REVIEW");
    expect(second).toContain("Human notes stay exactly here.");
    expect(second).toContain("<!-- FORGE:REVIEW:BEGIN -->");
    expect(second).not.toContain("status: DONE");
  });

  it("rejects DONE, path escape, and symlinked task notes", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-review-"));
    const vault = join(root, "vault");
    await mkdir(vault);
    const outside = join(root, "outside.md");
    await writeFile(outside, "human");
    await symlink(outside, join(vault, "linked.md"));

    await expect(
      syncObsidianReview(vault, "../outside.md", review),
    ).rejects.toBeInstanceOf(ObsidianReviewSyncError);
    await expect(
      syncObsidianReview(vault, "linked.md", review),
    ).rejects.toBeInstanceOf(ObsidianReviewSyncError);
    await expect(
      syncObsidianReview(vault, "note.md", {
        ...review,
        status: "DONE" as never,
      }),
    ).rejects.toBeInstanceOf(ObsidianReviewSyncError);
    await expect(
      syncObsidianReview(vault, "note.md", {
        ...review,
        pr_url: "https://evil.example/acme/forge/pull/42",
      }),
    ).rejects.toBeInstanceOf(ObsidianReviewSyncError);
  });
});
