import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { GitCandidateVerifier } from "../packages/adapters/src/git-candidate-verifier.js";

const execFile = promisify(execFileCallback);

it("rejects dirty or changed candidates before proof can run", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-proof-candidate-"));
  await execFile("git", ["init", "-b", "main", root]);
  await execFile("git", ["config", "user.email", "forge@example.test"], {
    cwd: root,
  });
  await execFile("git", ["config", "user.name", "Forge Tests"], { cwd: root });
  await writeFile(join(root, "app.ts"), "export const value = 1;\n");
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-m", "candidate"], { cwd: root });
  const candidate = (
    await execFile("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    })
  ).stdout.trim();
  const verifier = new GitCandidateVerifier(root);
  await expect(verifier.assertCurrent(candidate)).resolves.toBeUndefined();
  await writeFile(join(root, "app.ts"), "export const value = 2;\n");
  await expect(verifier.assertCurrent(candidate)).rejects.toThrow(
    "VALIDATION_WORKTREE_DIRTY",
  );
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-m", "changed"], { cwd: root });
  await expect(verifier.assertCurrent(candidate)).rejects.toThrow(
    "VALIDATION_CANDIDATE_CHANGED",
  );
});
