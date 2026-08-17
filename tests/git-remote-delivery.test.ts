import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  GitRemoteDeliveryAdapter,
  type GitCommandRunner,
} from "../packages/adapters/src/git-remote-adapter.js";

const execFile = promisify(execFileCallback);

async function repositories() {
  const root = await mkdtemp(join(tmpdir(), "forge-remote-"));
  const worktree = join(root, "worktree");
  const remote = join(root, "remote.git");
  await execFile("git", ["init", "--bare", remote]);
  await execFile("git", ["init", "-b", "main", worktree]);
  await execFile("git", ["config", "user.email", "forge@example.test"], {
    cwd: worktree,
  });
  await execFile("git", ["config", "user.name", "Forge Tests"], {
    cwd: worktree,
  });
  await writeFile(join(worktree, "base.txt"), "base\n");
  await execFile("git", ["add", "."], { cwd: worktree });
  await execFile("git", ["commit", "-m", "base"], { cwd: worktree });
  await execFile("git", ["remote", "add", "origin", remote], { cwd: worktree });
  await execFile("git", ["push", "origin", "main"], { cwd: worktree });
  const baseSha = (
    await execFile("git", ["rev-parse", "main"], {
      cwd: worktree,
      encoding: "utf8",
    })
  ).stdout.trim();
  await execFile("git", ["switch", "-c", "forge/MF-42"], { cwd: worktree });
  await writeFile(join(worktree, "task.txt"), "candidate\n");
  await execFile("git", ["add", "."], { cwd: worktree });
  await execFile("git", ["commit", "-m", "candidate"], { cwd: worktree });
  const candidate = (
    await execFile("git", ["rev-parse", "HEAD"], {
      cwd: worktree,
      encoding: "utf8",
    })
  ).stdout.trim();
  return { worktree, remote, candidate, baseSha };
}

describe("GitRemoteDeliveryAdapter", () => {
  it("verifies identity and pushes only the exact task branch idempotently", async () => {
    const { worktree, remote, candidate, baseSha } = await repositories();
    const adapter = new GitRemoteDeliveryAdapter(worktree);
    const request = {
      remote: "origin",
      expected_repository: remote,
      default_branch: "main",
      task_branch: "forge/MF-42",
      candidate_sha: candidate,
      base_sha: baseSha,
    } as const;
    await expect(adapter.inspect(request)).resolves.toMatchObject({
      identity_verified: true,
      candidate_sha: candidate,
    });
    await expect(adapter.pushTaskBranch(request)).resolves.toMatchObject({
      status: "PUSHED",
      pushed_sha: candidate,
    });
    await expect(adapter.pushTaskBranch(request)).resolves.toMatchObject({
      status: "ALREADY_UP_TO_DATE",
      pushed_sha: candidate,
    });
    await writeFile(join(worktree, "task.txt"), "next candidate\n");
    await execFile("git", ["commit", "-am", "next candidate"], {
      cwd: worktree,
    });
    const nextCandidate = (
      await execFile("git", ["rev-parse", "HEAD"], {
        cwd: worktree,
        encoding: "utf8",
      })
    ).stdout.trim();
    await expect(
      adapter.pushTaskBranch({ ...request, candidate_sha: nextCandidate }),
    ).resolves.toMatchObject({ status: "PUSHED", pushed_sha: nextCandidate });
    await expect(
      execFile("git", [
        "--git-dir",
        remote,
        "show-ref",
        "--verify",
        "refs/heads/forge/MF-42",
      ]),
    ).resolves.toBeDefined();
  });

  it("fails closed on repository identity, default branch, unsafe refs, and candidate mismatch", async () => {
    const { worktree, remote, candidate, baseSha } = await repositories();
    const adapter = new GitRemoteDeliveryAdapter(worktree);
    const base = {
      remote: "origin",
      expected_repository: remote,
      default_branch: "main",
      task_branch: "forge/MF-42",
      candidate_sha: candidate,
      base_sha: baseSha,
    } as const;
    await expect(
      adapter.pushTaskBranch({
        ...base,
        expected_repository: `${remote}-other`,
      }),
    ).rejects.toThrow("REMOTE_IDENTITY_MISMATCH");
    await expect(
      adapter.pushTaskBranch({ ...base, task_branch: "main" }),
    ).rejects.toThrow("DEFAULT_BRANCH_PUSH_PROHIBITED");
    await expect(
      adapter.pushTaskBranch({ ...base, protected_branches: ["forge/MF-42"] }),
    ).rejects.toThrow("PROTECTED_BRANCH_PUSH_PROHIBITED");
    await expect(
      adapter.pushTaskBranch({ ...base, task_branch: "--force" }),
    ).rejects.toThrow("INVALID_TASK_BRANCH");
    await expect(
      adapter.pushTaskBranch({ ...base, candidate_sha: "a".repeat(40) }),
    ).rejects.toThrow("CANDIDATE_MISMATCH");
    await expect(
      adapter.pushTaskBranch({ ...base, base_sha: "a".repeat(40) }),
    ).rejects.toThrow("REMOTE_BASE_STALE");
    await execFile(
      "git",
      [
        "config",
        "remote.origin.url",
        "https://token@github.com/meraki/forge.git",
      ],
      { cwd: worktree },
    );
    await expect(
      adapter.inspect({
        ...base,
        expected_repository: "https://github.com/meraki/forge.git",
      }),
    ).rejects.toThrow("REMOTE_CREDENTIAL_URL_PROHIBITED");
  });

  it("requires a clean proof-bound candidate and verifies the exact post-push ref", async () => {
    const { worktree, remote, candidate, baseSha } = await repositories();
    const request = {
      remote: "origin",
      expected_repository: remote,
      default_branch: "main",
      task_branch: "forge/MF-42",
      candidate_sha: candidate,
      base_sha: baseSha,
    } as const;
    await writeFile(join(worktree, "dirty.txt"), "dirty\n");
    await expect(
      new GitRemoteDeliveryAdapter(worktree).pushTaskBranch(request),
    ).rejects.toThrow("DELIVERY_WORKTREE_DIRTY");
    await execFile("git", ["clean", "-f"], { cwd: worktree });
    let taskQueries = 0;
    const runner: GitCommandRunner = (args) => {
      const command = args.join(" ");
      if (command === "remote get-url origin")
        return Promise.resolve({ stdout: `${remote}\n`, stderr: "" });
      if (command === "status --porcelain=v1 -z")
        return Promise.resolve({ stdout: "", stderr: "" });
      if (command === "rev-parse --verify HEAD^{commit}")
        return Promise.resolve({ stdout: `${candidate}\n`, stderr: "" });
      if (command === "symbolic-ref --quiet --short HEAD")
        return Promise.resolve({ stdout: "forge/MF-42\n", stderr: "" });
      if (command.includes("refs/heads/main"))
        return Promise.resolve({
          stdout: `${baseSha}\trefs/heads/main\n`,
          stderr: "",
        });
      if (command.includes("refs/heads/forge/MF-42"))
        return Promise.resolve({
          stdout:
            taskQueries++ === 0
              ? ""
              : `${"d".repeat(40)}\trefs/heads/forge/MF-42\n`,
          stderr: "",
        });
      return Promise.resolve({ stdout: "", stderr: "" });
    };
    await expect(
      new GitRemoteDeliveryAdapter(worktree, runner).pushTaskBranch(request),
    ).rejects.toThrow("POST_PUSH_REF_MISMATCH");
  });

  it("rejects a candidate when the remote base advances after proof freezes", async () => {
    const { worktree, remote, candidate, baseSha } = await repositories();
    await execFile("git", ["switch", "main"], { cwd: worktree });
    await writeFile(join(worktree, "base.txt"), "advanced base\n");
    await execFile("git", ["commit", "-am", "advance main"], {
      cwd: worktree,
    });
    await execFile("git", ["push", "origin", "main"], { cwd: worktree });
    await execFile("git", ["switch", "forge/MF-42"], { cwd: worktree });

    await expect(
      new GitRemoteDeliveryAdapter(worktree).pushTaskBranch({
        remote: "origin",
        expected_repository: remote,
        default_branch: "main",
        task_branch: "forge/MF-42",
        candidate_sha: candidate,
        base_sha: baseSha,
      }),
    ).rejects.toThrow("REMOTE_BASE_STALE");
  });

  it("uses a narrow non-force refspec and cannot expose arbitrary push arguments", async () => {
    const mutableCalls: string[][] = [];
    let pushed = false;
    const runner: GitCommandRunner = (args) => {
      mutableCalls.push([...args]);
      const command = args.join(" ");
      if (command === "remote get-url origin")
        return Promise.resolve({
          stdout: "git@github.com:meraki/forge.git\n",
          stderr: "",
        });
      if (command === "rev-parse --verify HEAD^{commit}")
        return Promise.resolve({ stdout: `${"b".repeat(40)}\n`, stderr: "" });
      if (command === "symbolic-ref --quiet --short HEAD")
        return Promise.resolve({ stdout: "forge/MF-7\n", stderr: "" });
      if (command === "status --porcelain=v1 -z")
        return Promise.resolve({ stdout: "", stderr: "" });
      if (command.includes("refs/heads/main"))
        return Promise.resolve({
          stdout: `${"a".repeat(40)}\trefs/heads/main\n`,
          stderr: "",
        });
      if (command.startsWith("push ")) {
        pushed = true;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (command.includes("refs/heads/forge/MF-7"))
        return Promise.resolve({
          stdout: pushed ? `${"b".repeat(40)}\trefs/heads/forge/MF-7\n` : "",
          stderr: "",
        });
      return Promise.resolve({ stdout: "", stderr: "" });
    };
    await new GitRemoteDeliveryAdapter("/repo", runner).pushTaskBranch({
      remote: "origin",
      expected_repository: "https://github.com/meraki/forge.git",
      default_branch: "main",
      task_branch: "forge/MF-7",
      candidate_sha: "b".repeat(40),
      base_sha: "a".repeat(40),
    });
    expect(mutableCalls.at(-2)).toEqual([
      "push",
      "--porcelain",
      "origin",
      `${"b".repeat(40)}:refs/heads/forge/MF-7`,
    ]);
    expect(mutableCalls.flat()).not.toContain("--force");
  });
});
