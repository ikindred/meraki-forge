import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createSemanticConflict } from "../../kernel/src/integration.js";

const execFile = promisify(execFileCallback);

interface ApplyApprovedCommitInput {
  readonly worktree: string;
  readonly commit: string;
  readonly approved_commits: readonly string[];
  readonly task_id: string;
  readonly run_id: string;
  readonly created_at: string;
}

/** Applies an immutable, previously approved Git commit; it never authors conflict content. */
export async function applyApprovedCommit(input: ApplyApprovedCommitInput) {
  if (!/^[a-f0-9]{40}$/.test(input.commit))
    throw new Error("Approved integration requires a full commit SHA");
  if (!input.approved_commits.includes(input.commit))
    throw new Error(
      "Integration commit is not present in the approved output set",
    );
  await execFile("git", ["cat-file", "-e", `${input.commit}^{commit}`], {
    cwd: input.worktree,
  });
  const baseline = (
    await execFile("git", ["rev-parse", "HEAD"], {
      cwd: input.worktree,
      encoding: "utf8",
    })
  ).stdout.trim();
  const status = (
    await execFile(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: input.worktree, encoding: "utf8" },
    )
  ).stdout;
  if (status.length)
    throw new Error("Approved integration requires a clean worktree and index");
  try {
    await execFile("git", ["cherry-pick", "--no-commit", input.commit], {
      cwd: input.worktree,
    });
    const approvedPaths = await changedPaths(input.worktree, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      input.commit,
    ]);
    const appliedPaths = await changedPaths(input.worktree, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
    ]);
    if (JSON.stringify(approvedPaths) !== JSON.stringify(appliedPaths))
      throw new Error("Applied tree differs from approved commit paths");
    const expectedTree = (
      await execFile("git", ["write-tree"], {
        cwd: input.worktree,
        encoding: "utf8",
      })
    ).stdout.trim();
    await execFile(
      "git",
      [
        "-c",
        "user.name=Meraki Forge",
        "-c",
        "user.email=forge@local.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        `forge: integrate approved ${input.commit.slice(0, 12)}`,
      ],
      { cwd: input.worktree },
    );
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
      cwd: input.worktree,
      encoding: "utf8",
    });
    const finalTree = (
      await execFile("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: input.worktree,
        encoding: "utf8",
      })
    ).stdout.trim();
    const finalStatus = (
      await execFile(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        {
          cwd: input.worktree,
          encoding: "utf8",
        },
      )
    ).stdout;
    if (finalTree !== expectedTree || finalStatus.length)
      throw new Error("Integrated commit did not preserve the verified tree");
    return Object.freeze({
      status: "APPLIED" as const,
      candidate: stdout.trim(),
    });
  } catch {
    await execFile("git", ["reset", "--hard", baseline], {
      cwd: input.worktree,
    });
    await execFile("git", ["clean", "-fd"], { cwd: input.worktree });
    return Object.freeze({
      status: "SEMANTIC_CONFLICT" as const,
      message: createSemanticConflict({
        id: `conflict-${input.commit.slice(0, 16)}`,
        task_id: input.task_id,
        run_id: input.run_id,
        created_at: input.created_at,
        affected_paths: [],
        reason: "Approved commit could not be applied mechanically",
        alternatives: [
          "Architect and affected owners resolve the conflict",
          "Rebase and re-approve the specialist output",
        ],
      }),
    });
  }
}

async function changedPaths(worktree: string, args: readonly string[]) {
  const { stdout } = await execFile("git", [...args], {
    cwd: worktree,
    encoding: "buffer",
  });
  return stdout.toString("utf8").split("\0").filter(Boolean).sort();
}
