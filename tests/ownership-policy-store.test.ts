import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FileOwnershipPolicyStore } from "../packages/adapters/src/ownership-policy-store.js";
import type { ApprovedOwnershipFile } from "../packages/execution/src/ownership-review.js";

const policy: ApprovedOwnershipFile = {
  schema_version: "1",
  default_effect: "deny",
  rules: [],
  ambiguities: [],
  review: {
    approved_by: "Operator",
    approved_at: "2026-08-17T00:00:00.000Z",
    repository_path: "/placeholder",
    candidate_commit: "a".repeat(40),
    proposal_digest: "b".repeat(64),
    policy_digest: "c".repeat(64),
  },
};
const execFile = promisify(execFileCallback);

describe("file ownership policy store", () => {
  it("atomically writes inside a canonical real .forge directory", async () => {
    const repository = await realpath(
      await mkdtemp(join(tmpdir(), "forge-owner-store-")),
    );
    await mkdir(join(repository, ".forge"));
    await writeFile(join(repository, ".forge/config.yml"), "version: 1\n");
    await execFile("git", ["init"], { cwd: repository });
    await execFile("git", ["config", "user.email", "test@example.com"], {
      cwd: repository,
    });
    await execFile("git", ["config", "user.name", "Test"], {
      cwd: repository,
    });
    await execFile("git", ["add", "."], { cwd: repository });
    await execFile("git", ["commit", "-m", "fixture"], { cwd: repository });
    const head = (
      await execFile("git", ["rev-parse", "HEAD"], { cwd: repository })
    ).stdout.trim();

    await new FileOwnershipPolicyStore().writeApprovedPolicy(repository, {
      ...policy,
      review: { ...policy.review, candidate_commit: head },
    });

    expect(
      await readFile(join(repository, ".forge/ownership.yml"), "utf8"),
    ).toContain("default_effect: deny");
  });

  it("rejects a symlinked .forge directory", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "forge-owner-store-")),
    );
    const repository = join(root, "repo");
    const outside = join(root, "outside");
    await mkdir(repository);
    await mkdir(outside);
    await symlink(outside, join(repository, ".forge"));

    await expect(
      new FileOwnershipPolicyStore().writeApprovedPolicy(repository, policy),
    ).rejects.toThrow(/real directory/u);
  });

  it("rejects a symlinked ownership target without changing its destination", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "forge-owner-store-")),
    );
    const repository = join(root, "repo");
    const forgeDirectory = join(repository, ".forge");
    const outside = join(root, "outside.yml");
    await mkdir(forgeDirectory, { recursive: true });
    await writeFile(outside, "preserved\n");
    await symlink(outside, join(forgeDirectory, "ownership.yml"));

    await expect(
      new FileOwnershipPolicyStore().writeApprovedPolicy(repository, policy),
    ).rejects.toThrow(/symbolic link/u);
    expect(await readFile(outside, "utf8")).toBe("preserved\n");
  });

  it("rejects a repository path reached through a symlink", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "forge-owner-store-")),
    );
    const repository = join(root, "repo");
    const alias = join(root, "repo-alias");
    await mkdir(join(repository, ".forge"), { recursive: true });
    await symlink(repository, alias);

    await expect(
      new FileOwnershipPolicyStore().writeApprovedPolicy(alias, policy),
    ).rejects.toThrow(/canonical/u);
  });
});
