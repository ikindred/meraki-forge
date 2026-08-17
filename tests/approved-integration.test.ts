import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { applyApprovedCommit } from "../packages/adapters/src/approved-integration.js";

const execFile = promisify(execFileCallback);

it("integrates only a commit in the approved immutable output set", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-approved-"));
  await execFile("git", ["init", "-b", "main", root]);
  await execFile("git", ["config", "user.email", "forge@example.test"], {
    cwd: root,
  });
  await execFile("git", ["config", "user.name", "Forge Tests"], { cwd: root });
  await writeFile(join(root, "base.txt"), "base\n");
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-m", "base"], { cwd: root });
  await execFile("git", ["switch", "-c", "approved"], { cwd: root });
  await writeFile(join(root, "approved.txt"), "approved\n");
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-m", "approved output"], { cwd: root });
  const commit = (
    await execFile("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    })
  ).stdout.trim();
  await execFile("git", ["switch", "main"], { cwd: root });
  const hooks = await mkdtemp(join(tmpdir(), "forge-hooks-"));
  const hook = join(hooks, "pre-commit");
  await writeFile(
    hook,
    "#!/bin/sh\necho injected > hook-injected.txt\ngit add hook-injected.txt\n",
  );
  await chmod(hook, 0o755);
  await execFile("git", ["config", "core.hooksPath", hooks], { cwd: root });

  await expect(
    applyApprovedCommit({
      worktree: root,
      commit,
      approved_commits: [],
      task_id: "MF-1",
      run_id: "run-1",
      created_at: "2026-08-11T00:00:00.000Z",
    }),
  ).rejects.toThrow("not present");
  await expect(
    applyApprovedCommit({
      worktree: root,
      commit,
      approved_commits: [commit],
      task_id: "MF-1",
      run_id: "run-1",
      created_at: "2026-08-11T00:00:00.000Z",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(access(join(root, "hook-injected.txt"))).rejects.toThrow();
  await writeFile(join(root, "dirty.txt"), "unapproved\n");
  await expect(
    applyApprovedCommit({
      worktree: root,
      commit,
      approved_commits: [commit],
      task_id: "MF-1",
      run_id: "run-1",
      created_at: "2026-08-11T00:00:00.000Z",
    }),
  ).rejects.toThrow("clean worktree");
});

it("returns a semantic conflict and restores the exact clean baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-conflict-"));
  await execFile("git", ["init", "-b", "main", root]);
  await execFile("git", ["config", "user.email", "forge@example.test"], {
    cwd: root,
  });
  await execFile("git", ["config", "user.name", "Forge Tests"], { cwd: root });
  await writeFile(join(root, "shared.txt"), "base\n");
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-m", "base"], { cwd: root });
  await execFile("git", ["switch", "-c", "approved"], { cwd: root });
  await writeFile(join(root, "shared.txt"), "approved\n");
  await execFile("git", ["commit", "-am", "approved output"], { cwd: root });
  const approved = (
    await execFile("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    })
  ).stdout.trim();
  await execFile("git", ["switch", "main"], { cwd: root });
  await writeFile(join(root, "shared.txt"), "current\n");
  await execFile("git", ["commit", "-am", "current output"], { cwd: root });
  const baseline = (
    await execFile("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    })
  ).stdout.trim();

  await expect(
    applyApprovedCommit({
      worktree: root,
      commit: approved,
      approved_commits: [approved],
      task_id: "MF-2",
      run_id: "run-2",
      created_at: "2026-08-11T00:00:00.000Z",
    }),
  ).resolves.toMatchObject({
    status: "SEMANTIC_CONFLICT",
    message: { kind: "SEMANTIC_CONFLICT" },
  });
  await expect(
    execFile("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
  ).resolves.toMatchObject({ stdout: `${baseline}\n` });
  await expect(
    execFile("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
  ).resolves.toMatchObject({ stdout: "" });
});
